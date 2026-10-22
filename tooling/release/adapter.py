#!/usr/bin/env python3
"""Project-owned versioned lifecycle. No dependency on the scaffold installation."""
import contextlib
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / 'tooling/release/config.json'
CONFIG = json.loads(CONFIG_PATH.read_text())
EXCLUDED = {'.git', 'node_modules', '.venv', '__pycache__', '.cache', '.build', '.runtime', '.control-panel', '.omx', 'dist', 'build', 'coverage', '.next', '.vite', 'agent-docs'}
SECRET = ['.env', '.env.*', '*.sqlite', '*.sqlite-*', '*.sqlite3', '*.db', '*.db-*', '*.pem', '*.key', '*.p12', '*.pfx', '*credentials*']
KEY = hashlib.sha256(os.fsencode(str(ROOT))).hexdigest()[:24]
STORE = Path(os.environ.get('PROJECT_RELEASE_STORE', str(Path.home() / 'Library/Application Support/project-tooling/releases'))).expanduser().resolve() / KEY
ACTIVE = STORE / 'active.json'
BUILT = STORE / 'built.json'


def read_json(file, default=None):
    try:
        return json.loads(Path(file).read_text())
    except FileNotFoundError:
        return default


def atomic(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file.with_name(file.name + '.' + str(os.getpid()) + '.tmp')
    with temporary.open('x') as stream:
        json.dump(value, stream)
    temporary.chmod(0o600)
    temporary.replace(file)


def runtime_env():
    env = os.environ.copy()
    prefix = [p for p in CONFIG.get('pathPrefix', []) if Path(p).is_dir()]
    if prefix:
        env['PATH'] = os.pathsep.join(prefix + [env.get('PATH', '')])
    for key, value in CONFIG.get('runtimeEnvironment', {}).items():
        env.setdefault(key, value.replace('{origin}', str(ROOT)))
    if CONFIG.get('panel'):
        env['PROJECT_RELEASE_ORIGIN'] = str(ROOT)
    return env


def run(args, cwd=ROOT, env=None, check=True, timeout=120):
    return subprocess.run(args, cwd=cwd, env=env if env is not None else runtime_env(), check=check, timeout=timeout,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def excluded(relative):
    parts = Path(relative).parts
    paths = CONFIG.get('persistent', []) + CONFIG.get('runtimeFiles', []) + CONFIG.get('exclude', [])
    return (any(part in EXCLUDED for part in parts)
            or any(fnmatch.fnmatch(part, pattern) for part in parts for pattern in SECRET)
            or any(relative == p or relative.startswith(p + '/') for p in paths))


def files():
    # Git supplies tracked and nonignored untracked files; never walk live dependencies/data.
    result = run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])
    entries = []
    for value in sorted(set(result.stdout.split(b'\0'))):
        if not value:
            continue
        relative = os.fsdecode(value)
        if excluded(relative):
            continue
        file = ROOT / relative
        if not file.exists() and not file.is_symlink():
            continue  # A tracked deletion contributes by absence.
        if file.is_dir():
            continue  # Gitlinks are independently owned runtimes.
        if file.is_symlink():
            target = file.resolve(strict=True)
            if not target.is_relative_to(ROOT) or excluded(str(target.relative_to(ROOT))):
                raise RuntimeError('源码符号链接越界或引用运行数据: ' + relative)
            data = b'link:' + os.fsencode(os.readlink(file))
        else:
            data = file.read_bytes()
        entries.append((relative, file.stat().st_mode & 0o111, data))
    if not entries:
        raise RuntimeError('找不到可验证的源码输入')
    return entries


def executable():
    info = json.loads((ROOT / 'launchd.json').read_text())
    plist = Path(info['plist']).expanduser()
    config = plistlib.loads(plist.read_bytes())
    if config.get('Label') != info['label']:
        raise RuntimeError('launchd Label 不匹配')
    argv = config.get('ProgramArguments', [])
    binary = Path(config.get('Program') or (argv[0] if argv else ''))
    if not binary.is_absolute() or not binary.is_file():
        raise RuntimeError('无法确认 tunnel 客户端可执行文件')
    return binary, config


def toolchain():
    values = []
    for args in CONFIG.get('toolchain', []):
        result = run(args, timeout=15)
        values.append([args, (result.stdout + result.stderr).decode(errors='replace').strip()])
    return values


def build_values():
    values = {}
    allowed = set(CONFIG.get('buildEnvironment', []))
    for relative in CONFIG.get('buildEnvFiles', []):
        file = ROOT / relative
        if not file.exists():
            continue
        for line in file.read_text().splitlines():
            key, separator, value = line.strip().removeprefix('export ').partition('=')
            if not separator or key.strip() not in allowed:
                continue
            value = value.strip()
            if value[:1] in {'"', "'"} and value[-1:] == value[:1]:
                value = value[1:-1]
            if '$' in value or '\n' in value:
                raise RuntimeError('构建环境需使用确定的字面量: ' + key.strip())
            values[key.strip()] = value
    for key in allowed:
        if key in os.environ:
            values[key] = os.environ[key]
    return values


def source():
    entries = files()
    digest = hashlib.sha256()
    for name, mode, data in entries:
        digest.update(json.dumps([name, mode, len(data)], ensure_ascii=True).encode() + b'\0' + data)
    digest.update(json.dumps(toolchain(), sort_keys=True).encode())
    if CONFIG.get('tunnel'):
        binary, _ = executable()
        digest.update(hashlib.sha256(binary.read_bytes()).digest())
    digest.update(json.dumps(build_values(), sort_keys=True, ensure_ascii=True).encode())
    return 'sha256:' + digest.hexdigest(), entries


def signature(pid):
    if not isinstance(pid, int) or pid < 2:
        return None
    result = run(['ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command='], check=False)
    return result.stdout.decode(errors='replace').strip() if result.returncode == 0 else None


def identities(directory):
    # Match an exact artifact directory, never a broad application/process name.
    result = run(['ps', '-axo', 'pid=,command='])
    selected = set()
    prefix = str(directory) + '/'
    for line in result.stdout.decode(errors='replace').splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and prefix in parts[1]:
            selected.add(int(parts[0]))
    result = run(['lsof', '-a', '-d', 'cwd', '-F', 'pn'], check=False, timeout=10)
    pid = None
    for line in result.stdout.decode(errors='replace').splitlines():
        if line.startswith('p'):
            pid = int(line[1:])
        elif line.startswith('n') and pid and (line[1:] == str(directory) or line[1:].startswith(prefix)):
            selected.add(pid)
    # Exclude this operation and its ancestors, including the panel/CLI caller.
    ancestor = os.getpid()
    while ancestor > 1:
        selected.discard(ancestor)
        result = run(['ps', '-p', str(ancestor), '-o', 'ppid='], check=False)
        try:
            ancestor = int(result.stdout.strip())
        except ValueError:
            break
    records = [{'pid': p, 'identity': signature(p)} for p in sorted(selected)]
    time.sleep(.15)
    return [r for r in records if r['identity'] and signature(r['pid']) == r['identity']]


def active():
    record = read_json(ACTIVE)
    if not record:
        return None
    directory = artifact(record['artifactId'])
    if not directory.is_dir():
        raise RuntimeError('活动产物已丢失，不能回退接管原进程')
    return record


def artifact(identifier):
    if not isinstance(identifier, str) or not identifier.startswith('sha256:') or len(identifier) != 71 or any(c not in '0123456789abcdef' for c in identifier[7:]):
        raise RuntimeError('非法产物标识')
    return STORE / identifier[7:]


def content(file):
    if file.is_symlink():
        return 'link:' + os.readlink(file)
    return hashlib.sha256(file.read_bytes()).hexdigest()


def inventory(directory):
    records = []
    for root, dirs, names in os.walk(directory, followlinks=False):
        current = Path(root)
        relative = current.relative_to(directory)
        dirs[:] = [d for d in dirs if d not in {'.cache', '.git', '__pycache__', '.vite'}
                   and d not in {'.runtime', '.omx'} and str(relative / d) not in CONFIG.get('persistent', [])]
        if str(relative).startswith('.control-panel'):
            dirs[:] = [d for d in dirs if str(relative / d).startswith('.control-panel/bin')]
            if str(relative) != '.control-panel/bin' and not str(relative).startswith('.control-panel/bin/'):
                names = []
        for name in sorted(names + [d for d in dirs if (current / d).is_symlink()]):
            file = current / name
            rel = str(file.relative_to(directory))
            if rel in CONFIG.get('runtimeFiles', []) or rel in {'.release-integrity.json', '.release-ready.json'} or rel.startswith('.control-panel/logs/') or file.suffix in {'.log', '.pid'}:
                continue
            if file.is_symlink() and not file.resolve().is_relative_to(directory):
                raise RuntimeError('产物依赖链接越界: ' + rel)
            records.append([rel, content(file), file.stat().st_mode & 0o111])
    return sorted(records)


def verified(identifier, full=False):
    directory = artifact(identifier)
    ready = read_json(directory / '.release-ready.json')
    if not ready or ready.get('builtRevision') != identifier:
        return False
    try:
        if full:
            return inventory(directory) == read_json(directory / '.release-integrity.json')
        if any(not (directory / name).exists() for name in ready.get('outputs', [])):
            return False
        for name, digest, mode in ready['checks']:
            file = directory / name
            if not file.exists() or content(file) != digest or file.stat().st_mode & 0o111 != mode:
                return False
        return True
    except (OSError, ValueError):
        return False


def state():
    revision, _ = source()
    built = read_json(BUILT)
    built_revision = built['builtRevision'] if built and verified(built['builtRevision']) else None
    record = active()
    running = None
    if record and verified(record['artifactId']):
        matches = [p for p in record['processes'] if signature(p['pid']) == p['identity']]
        if matches:
            running = record['runningRevision']
    return dict(sourceRevision=revision, builtRevision=built_revision, runningRevision=running)


@contextlib.contextmanager
def lock():
    import fcntl
    STORE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STORE / 'operation.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('另一个版本操作正在进行')
        yield


def build_env(directory):
    env = runtime_env()
    # Runtime data overrides must not enter the isolated build.
    for key in CONFIG.get('runtimeEnvironment', {}):
        env.pop(key, None)
    env.update(build_values())
    env['npm_config_production'] = 'false'
    cache = STORE.parent / '.build-cache'
    cache.mkdir(parents=True, exist_ok=True)
    env.update(XDG_CACHE_HOME=str(cache), PIP_CACHE_DIR=str(cache / 'pip'), npm_config_cache=str(cache / 'npm'),
               npm_config_store_dir=str(cache / 'pnpm'), npm_config_enable_global_virtual_store='false', npm_config_package_import_method='copy', COREPACK_HOME=str(cache / 'corepack'),
               ELECTRON_CACHE=str(cache / 'electron'), GOCACHE=str(cache / 'go-build'),
               GOMODCACHE=str(cache / 'go-mod'), CLANG_MODULE_CACHE_PATH=str(cache / 'clang'),
               SWIFT_MODULECACHE_PATH=str(cache / 'swift'), PYTHONPYCACHEPREFIX=str(cache / 'python'))
    return env


def prepare():
    target = os.environ.get('PROJECT_TARGET_REVISION')
    revision, entries = source()
    if target != revision:
        raise RuntimeError('代码已变化，拒绝构建不同版本')
    if verified(target, full=True):
        atomic(BUILT, dict(builtRevision=target))
        return dict(builtRevision=target, artifactId=target)
    directory = artifact(target)
    if active() and active()['artifactId'] == target:
        raise RuntimeError('活动产物已损坏，拒绝原地重建')
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, mode=0o700)
    try:
        for name, mode, data in entries:
            file = directory / name
            file.parent.mkdir(parents=True, exist_ok=True)
            if data.startswith(b'link:') and (ROOT / name).is_symlink():
                file.symlink_to(os.fsdecode(data[5:]))
            else:
                file.write_bytes(data)
                file.chmod(0o644 | mode)
        if CONFIG.get('packageManager'):
            package_file = directory / 'package.json'
            package = json.loads(package_file.read_text())
            package['packageManager'] = CONFIG['packageManager']
            package_file.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
        for patch in CONFIG.get('patches', []):
            file = directory / patch['file']
            text = file.read_text()
            if patch['before'] not in text:
                raise RuntimeError('启动脚本已变化，需要重新检查适配: ' + patch['file'])
            file.write_text(text.replace(patch['before'], patch['after']))
        if CONFIG.get('tunnel'):
            binary, _ = executable()
            (directory / 'bin').mkdir()
            shutil.copy2(binary, directory / 'bin/tunnel-client')
            info = json.loads((directory / 'launchd.json').read_text())
            info['plist'] = str(directory / '.runtime/launch-agent.plist')
            (directory / 'launchd.json').write_text(json.dumps(info))
        env = build_env(directory)
        for args in CONFIG.get('prepare', []):
            print('准备: ' + ' '.join(args), file=sys.stderr)
            # Stream build logs to stderr; never buffer an unbounded install/build log.
            child = subprocess.Popen(args, cwd=directory, env=env, stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
            try:
                code = child.wait(timeout=CONFIG.get('prepareStepTimeoutSec', 900))
                if code:
                    raise RuntimeError('准备命令失败，退出码 ' + str(code))
            except BaseException:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                raise
        for name in CONFIG.get('outputs', []):
            if not (directory / name).exists():
                raise RuntimeError('构建缺少必要产物: ' + name)
        if source()[0] != target:
            raise RuntimeError('准备期间源码已改变，保留旧服务')
        records = inventory(directory)
        checks = [r for r in records if not any(part in {'node_modules', '.cache', '.venv', '.control-panel'} for part in Path(r[0]).parts)]
        # Required native binaries can live in .control-panel/bin.
        checks += [r for r in records if r[0].startswith('.control-panel/bin/') and r not in checks]
        atomic(directory / '.release-integrity.json', records)
        atomic(directory / '.release-ready.json', dict(builtRevision=target, checks=checks, outputs=CONFIG.get('outputs', [])))
        atomic(BUILT, dict(builtRevision=target))
        return dict(builtRevision=target, artifactId=target)
    except BaseException:
        # Only this locked invocation created the directory; no active version uses it.
        shutil.rmtree(directory)
        raise


def legacy(action, directory=ROOT, check=True):
    args = CONFIG['legacy'][action]
    return run(args, cwd=directory, check=check, timeout=CONFIG.get('startupTimeoutSec', 180))


def attach_runtime(directory):
    # No original data/config is exposed during prepare. Attach only at explicit activation.
    paths = CONFIG.get('persistent', []) + CONFIG.get('runtimeFiles', [])
    for name in paths:
        destination = directory / name
        original = ROOT / name
        if not original.exists() and not original.is_symlink():
            if name in CONFIG.get('persistent', []):
                original.mkdir(parents=True, exist_ok=True)
            else:
                continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            if destination.is_dir() and not destination.is_symlink():
                shutil.rmtree(destination)
            else:
                destination.unlink()
        destination.symlink_to(original)
    if CONFIG.get('tunnel'):
        _, plist = executable()
        info = json.loads((directory / 'launchd.json').read_text())
        argv = plist.get('ProgramArguments', [])
        if 'Program' in plist:
            plist['Program'] = str(directory / 'bin/tunnel-client')
        elif argv:
            argv[0] = str(directory / 'bin/tunnel-client')
        private = directory / '.runtime/launch-agent.plist'
        private.parent.mkdir(parents=True, exist_ok=True)
        private.write_bytes(plistlib.dumps(plist))
        private.chmod(0o600)
        if info['plist'] != str(private):
            raise RuntimeError('准备好的 launchd 配置路径不匹配')


def stop():
    record = active()
    result = legacy('stop', artifact(record['artifactId']) if record else ROOT, check=False)
    sys.stderr.buffer.write(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('停止失败，拒绝切换')
    if record:
        if any(signature(p['pid']) == p['identity'] for p in record['processes']):
            raise RuntimeError('停止后仍有目标版本进程存活，拒绝切换')
        ACTIVE.unlink(missing_ok=True)
    return dict(status='stopped')


def status():
    record = active()
    result = legacy('status', artifact(record['artifactId']) if record else ROOT, check=False)
    sys.stderr.buffer.write(result.stdout + result.stderr)
    if record and not any(signature(p['pid']) == p['identity'] for p in record['processes']):
        return dict(status='unknown'), 3
    return dict(status='running' if result.returncode == 0 else 'stopped'), result.returncode


def activate():
    target = os.environ.get('PROJECT_TARGET_REVISION')
    identifier = os.environ.get('PROJECT_ARTIFACT_ID')
    if identifier != target or not verified(identifier, full=True):
        raise RuntimeError('产物损坏或目标版本不一致')
    if active():
        raise RuntimeError('旧版本尚未停止，拒绝激活')
    # Refuse to take over a still-running original service.
    if legacy('status', check=False).returncode == 0:
        raise RuntimeError('原服务仍在运行，拒绝激活')
    directory = artifact(identifier)
    attach_runtime(directory)
    result = legacy('start', directory, check=False)
    sys.stderr.buffer.write(result.stdout + result.stderr)
    processes = identities(directory)
    # Record real process identities even on partial startup failure, so stop can address them.
    if processes:
        atomic(ACTIVE, dict(artifactId=identifier, runningRevision=target, processes=processes))
    if result.returncode or not processes or legacy('status', directory, check=False).returncode:
        raise RuntimeError('新版启动或进程身份核验失败；保留实际进程记录供排查')
    return dict(runningRevision=target)


def main():
    action = sys.argv[1]
    if action == 'version':
        print(json.dumps(state()))
        return
    if action == 'status':
        value, code = status()
        print(json.dumps(value))
        sys.exit(code)
    with lock():
        if action == 'prepare':
            value = prepare()
        elif action == 'activate':
            value = activate()
        elif action == 'stop':
            value = stop()
        elif action in {'start', 'restart'}:
            if action == 'start' and status()[1] == 0:
                value = dict(status='running')
            else:
                os.environ['PROJECT_TARGET_REVISION'] = source()[0]
                prepared = prepare()
                os.environ['PROJECT_ARTIFACT_ID'] = prepared['artifactId']
                stop()
                value = activate()
        else:
            raise RuntimeError('不支持的操作')
        print(json.dumps(value))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
