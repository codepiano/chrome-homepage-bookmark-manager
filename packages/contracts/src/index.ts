import { z } from 'zod';

export const themeSchema = z.enum(['system', 'light', 'dark']);
export const layoutSchema = z.enum(['grid', 'list']);
export const metadataStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export const linkAppearanceSchema = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  cardColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().trim().max(8).optional(),
}).strict();

export const settingsSchema = z.object({
  theme: themeSchema.default('system'),
  layout: layoutSchema.default('grid'),
  columns: z.number().int().min(1).max(12).default(4),
  gap: z.number().int().min(4).max(64).default(20),
  cardWidth: z.number().int().min(160).max(640).default(280),
  centered: z.boolean().default(true),
  compact: z.boolean().default(false),
  showAddButton: z.boolean().default(true),
  showDescription: z.boolean().default(true),
  showClickCount: z.boolean().default(true),
  showLastVisited: z.boolean().default(true),
  fontFamily: z.string().max(200).default('system-ui, sans-serif'),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#172033'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2f67e8')
});
export type Settings = z.infer<typeof settingsSchema>;

export const folderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  autoRules: z.array(z.string()).default([]),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Folder = z.infer<typeof folderSchema>;

export const linkSchema = z.object({
  id: z.string().uuid(),
  folderId: z.string().uuid(),
  url: z.string().url(),
  title: z.string().max(300).nullable(),
  description: z.string().max(1_000).nullable(),
  faviconUrl: z.string().url().nullable(),
  appearanceOverride: linkAppearanceSchema.nullable(),
  displayName: z.string().max(300).nullable(),
  metadataStatus: metadataStatusSchema,
  metadataError: z.string().nullable(),
  metadataFetchedAt: z.string().nullable(),
  position: z.number(),
  clickCount: z.number().int().nonnegative().default(0),
  lastClickedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Link = z.infer<typeof linkSchema>;

export const autoRuleSchema = z.string().trim().toLowerCase().regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Use a domain such as github.com or *.github.com');
export const createFolderSchema = z.object({ name: z.string().trim().min(1).max(80), autoRules: z.array(autoRuleSchema).max(50).default([]) });
export const updateFolderSchema = createFolderSchema.partial();
export const createLinkSchema = z.object({
  url: z.string().url(),
  displayName: z.string().trim().max(300).optional(),
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1_000).optional(),
  appearanceOverride: linkAppearanceSchema.nullable().optional()
});
export const updateLinkSchema = createLinkSchema.partial().extend({
  faviconUrl: z.string().url().nullable().optional()
});

export const apiErrorSchema = z.object({ code: z.string(), message: z.string() });
