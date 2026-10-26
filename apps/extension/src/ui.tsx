import { forwardRef, useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Button as MantineButton, UnstyledButton, Input as MantineInput, NativeSelect, Textarea as MantineTextarea, Checkbox, Radio, Modal, Notification, MantineProvider, createTheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Settings } from './types';

const theme = createTheme({
  primaryColor: 'indigo', defaultRadius: 'md', fontFamily: 'inherit',
  components: {
    Button: MantineButton.extend({ defaultProps: { size: 'sm' } }),
    Input: MantineInput.extend({ defaultProps: { size: 'sm' } }),
    NativeSelect: NativeSelect.extend({ defaultProps: { size: 'sm', rightSectionWidth: 36 } }),
    Modal: Modal.extend({ defaultProps: { centered: true, size: 640, zIndex: 300 } }),
  },
});

export function AppProvider({ settings, children }: { settings: Settings; children: ReactNode }) {
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const colorScheme = settings.theme === 'system' ? systemDark ? 'dark' : 'light' : settings.theme;
  return <MantineProvider theme={theme} forceColorScheme={colorScheme}>{children}</MantineProvider>;
}

// Preserve DOM events, refs, form submission and drag attributes at the UI boundary.
export const Button = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(function Button({ className = '', type = 'submit', ...props }, ref) {
  const common = /(?:^|\s)(primary|quiet-button|text-button|danger|card-action|tab-add)(?:\s|$)/.test(className);
  if (!common) return <UnstyledButton {...props} type={type} ref={ref} className={className} />;
  return <MantineButton {...props} type={type} ref={ref} className={`ui-button ${className}`} color={className.includes('danger') ? 'red' : undefined} variant={className.includes('primary') ? 'filled' : className.includes('quiet-button') ? 'default' : 'subtle'} />;
});

export const Input = forwardRef<HTMLInputElement, Omit<ComponentProps<'input'>, 'size'>>(function Input(props, ref) {
  if (props.type === 'checkbox') return <Checkbox {...props} ref={ref} className={`ui-check ${props.className ?? ''}`} />;
  if (props.type === 'radio') return <Radio {...props} ref={ref} className={`ui-check ${props.className ?? ''}`} />;
  return <MantineInput {...props} ref={ref} className={`ui-input ${props.className ?? ''}`} />;
});
export function Select(props: Omit<ComponentProps<'select'>, 'size'>) { return <NativeSelect {...props} className={`ui-select ${props.className ?? ''}`} />; }
export function Textarea(props: ComponentProps<'textarea'>) { return <MantineTextarea {...props} className={`ui-textarea ${props.className ?? ''}`} autosize minRows={3} maxRows={8} />; }

export function DialogFrame({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const opener = useRef(document.activeElement);
  useEffect(() => () => {
    // Dialogs are conditionally mounted, so restore focus after unmount too.
    queueMicrotask(() => {
      const target = opener.current;
      if (!document.querySelector('[aria-modal="true"]') && target instanceof HTMLElement && target.isConnected) target.focus();
    });
  }, []);
  return <Modal opened onClose={onClose} title={title} closeButtonProps={{ 'aria-label': '关闭' }} withinPortal={false} classNames={{ content: 'dialog', body: 'dialog-body' }}>{children}</Modal>;
}
export function Toast({ children, action, onAction }: { children: ReactNode; action?: string; onAction?(): void }) {
  return <Notification className="ui-toast" role="status" withCloseButton={false}>{children}{action && <Button type="button" className="text-button" onClick={onAction}>{action}</Button>}</Notification>;
}
