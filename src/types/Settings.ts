import { z } from 'zod';

import { ColorLevelSchema } from './ColorLevel';
import { FlexModeSchema } from './FlexMode';
import { PowerlineConfigSchema } from './PowerlineConfig';
import { WidgetItemSchema } from './Widget';

// Current version - bump this when making breaking changes to the schema
export const CURRENT_VERSION = 3;

// Which side(s) of a widget the default padding is applied to
export const DefaultPaddingSideSchema = z.enum(['both', 'left', 'right']);
export type DefaultPaddingSide = z.infer<typeof DefaultPaddingSideSchema>;

export const InstallationMetadataSchema = z.discriminatedUnion('method', [
    z.object({
        method: z.literal('auto-update'),
        packageManager: z.enum(['npm', 'bun'])
    }),
    z.object({
        method: z.literal('pinned'),
        installedVersion: z.string().optional()
    }),
    z.object({
        method: z.literal('self-managed'),
        packageManager: z.enum(['npm', 'bun', 'unknown']).default('unknown')
    }),
    z.object({
        method: z.literal('unknown'),
        packageManager: z.enum(['npm', 'bun', 'unknown']).default('unknown')
    })
]);

// Schema for v1 settings (before version field was added)
export const SettingsSchema_v1 = z.object({
    lines: z.array(z.array(WidgetItemSchema)).optional(),
    flexMode: FlexModeSchema.optional(),
    compactThreshold: z.number().optional(),
    colorLevel: ColorLevelSchema.optional(),
    defaultSeparator: z.string().optional(),
    defaultPadding: z.string().optional(),
    inheritSeparatorColors: z.boolean().optional(),
    overrideBackgroundColor: z.string().optional(),
    overrideForegroundColor: z.string().optional(),
    globalBold: z.boolean().optional()
});

// Main settings schema with defaults
export const SettingsSchema = z.object({
    version: z.number().default(CURRENT_VERSION),
    lines: z.array(z.array(WidgetItemSchema))
        .min(1)
        // Fork default: thariman's layout — model/context/cwd/git on line 1,
        // session usage + credits on line 2, Fable + weekly usage on line 3.
        .default([
            [
                { id: 'l1-model', type: 'model', color: 'white', rawValue: true },
                { id: 'l1-effort', type: 'thinking-effort', color: 'cyan', rawValue: true },
                { id: 'l1-sep1', type: 'separator', color: 'gray', character: ' | ' },
                { id: 'l1-ctx', type: 'context-percentage', color: 'white', rawValue: false },
                { id: 'l1-sep2', type: 'separator', color: 'gray', character: ' | ' },
                { id: 'l1-cwd', type: 'current-working-dir', color: 'white', rawValue: true, metadata: { segments: '1', abbreviateHome: 'true' } },
                { id: 'l1-branch', type: 'git-branch', color: 'gray' },
                { id: 'l1-clean', type: 'git-clean-status' }
            ],
            [
                { id: 'l2-label', type: 'custom-text', customText: 'Curr ' },
                { id: 'l2-session', type: 'session-usage', color: 'green', rawValue: true, metadata: { display: 'progress', cursor: 'true' } },
                { id: 'l2-reset', type: 'reset-timer', color: 'green', rawValue: true, metadata: { display: 'time' } },
                { id: 'l2-sep', type: 'separator', color: 'gray', character: ' | ' },
                { id: 'l2-credits-label', type: 'custom-text', color: 'white', customText: 'crdts ' },
                { id: 'l2-credits', type: 'extra-usage-used', rawValue: true }
            ],
            [
                { id: 'l3-label', type: 'custom-text', color: 'white', customText: 'Fable' },
                { id: 'l3-fable', type: 'fable-weekly-usage', color: 'green', rawValue: true, metadata: { display: 'progress', invert: 'false' } },
                { id: 'l3-reset', type: 'weekly-reset-timer', color: 'green', rawValue: true, metadata: { display: 'time' } },
                { id: 'l3-sep1', type: 'separator', color: 'gray', character: ' | ' },
                { id: 'l3-label2', type: 'custom-text', color: 'white', customText: 'wkly ' },
                { id: 'l3-bar2', type: 'weekly-usage', color: 'green', rawValue: true, metadata: { display: 'progress-short' } }
            ]
        ]), // Ensure max 3 lines
    flexMode: FlexModeSchema.default('full-minus-40'),
    compactThreshold: z.number().min(1).max(99).default(60),
    colorLevel: ColorLevelSchema.default(2),
    defaultSeparator: z.string().optional(),
    defaultPadding: z.string().optional(),
    defaultPaddingSide: DefaultPaddingSideSchema.default('both'),
    inheritSeparatorColors: z.boolean().default(false),
    overrideBackgroundColor: z.string().optional(),
    overrideForegroundColor: z.string().optional(),
    globalBold: z.boolean().default(false),
    gitCacheTtlSeconds: z.number().min(0).max(60).default(5),
    minimalistMode: z.boolean().default(false),
    powerline: PowerlineConfigSchema.default({
        enabled: false,
        separators: ['\uE0B0'],
        separatorInvertBackground: [false],
        startCaps: [],
        endCaps: [],
        theme: undefined,
        autoAlign: false,
        continueThemeAcrossLines: false
    }),
    updatemessage: z.object({
        message: z.string().nullable().optional(),
        remaining: z.number().nullable().optional()
    }).optional(),
    installation: InstallationMetadataSchema.optional()
});

// Inferred type from schema
export type Settings = z.infer<typeof SettingsSchema>;
export type InstallationMetadata = z.infer<typeof InstallationMetadataSchema>;
export type ResolvedInstallationMetadata
    = | Exclude<InstallationMetadata, { method: 'pinned' }>
        | (Extract<InstallationMetadata, { method: 'pinned' }> & { packageManager: 'npm' | 'bun' | 'unknown' });

// Export a default settings constant for reference
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
