import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Mock } from 'vitest';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import * as claudeSettings from '../claude-settings';
import {
    getUsageToken,
    parseMacKeychainCredentialCandidates
} from '../usage-fetch';

vi.mock('child_process', () => ({
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn()
}));

// A non-default config dir (distinct from the real ~/.claude), used to
// exercise the config-dir-derived keychain service. The service name mirrors
// getConfigDirKeychainService in usage-fetch.ts (bare service + sha256(configDir)[:8]).
const NON_DEFAULT_CONFIG_DIR = '/fake/claude';
const NON_DEFAULT_KEYCHAIN_SERVICE = `Claude Code-credentials-${createHash('sha256').update(NON_DEFAULT_CONFIG_DIR).digest('hex').slice(0, 8)}`;
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');
const CREDENTIALS_FILE = path.join(NON_DEFAULT_CONFIG_DIR, '.credentials.json');
const DEFAULT_CREDENTIALS_FILE = path.join(DEFAULT_CONFIG_DIR, '.credentials.json');
const mockedExecFileSync = execFileSync as unknown as Mock;

function makeTokenPayload(token: string): string {
    return JSON.stringify({ claudeAiOauth: { accessToken: token } });
}

function encodeAsciiAsHex(value: string): string {
    return Buffer.from(value, 'utf8').toString('hex');
}

function makeKeychainBlock(service: string, modifiedAt?: { raw?: string; quoted?: string }): string {
    const lines = [
        'keychain: "/Users/example/Library/Keychains/login.keychain-db"',
        'version: 512',
        'class: "genp"',
        'attributes:',
        `    "svce"<blob>="${service}"`
    ];

    if (modifiedAt?.raw && modifiedAt.quoted) {
        lines.push(`    "mdat"<timedate>=0x${modifiedAt.raw}    "${modifiedAt.quoted}"`);
    } else if (modifiedAt?.raw) {
        lines.push(`    "mdat"<timedate>=0x${modifiedAt.raw}`);
    } else if (modifiedAt?.quoted) {
        lines.push(`    "mdat"<timedate>="${modifiedAt.quoted}"`);
    }

    return lines.join('\n');
}

function getSecurityCallLog(): string[] {
    return mockedExecFileSync.mock.calls.map((call) => {
        const [command, args]: [string, string[] | undefined] = call as [string, string[] | undefined];

        expect(command).toBe('security');
        return Array.isArray(args) ? args.join(' ') : '';
    });
}

function mockCredentialsFile(payload?: string, expectedPath: string = CREDENTIALS_FILE): void {
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, options) => {
        if (filePath === expectedPath) {
            if (payload === undefined) {
                throw new Error('credentials file missing');
            }

            expect(options).toBe('utf8');
            return payload;
        }

        throw new Error(`Unexpected file read: ${String(filePath)}`);
    });
}

describe('parseMacKeychainCredentialCandidates', () => {
    it('returns hashed macOS credential candidates sorted newest-first and excludes the exact service', () => {
        const dump = [
            makeKeychainBlock('Claude Code-credentials', { quoted: '20240101010101Z' }),
            makeKeychainBlock('Claude Code-credentials-old', { quoted: '20240201010101Z' }),
            makeKeychainBlock('Claude Code-credentials-new', { quoted: '20240301010101Z' })
        ].join('\n');

        expect(parseMacKeychainCredentialCandidates(dump)).toEqual([
            'Claude Code-credentials-new',
            'Claude Code-credentials-old'
        ]);
    });

    it('uses discovered order when modified times are unavailable and parses hex-only timestamps when present', () => {
        const dump = [
            makeKeychainBlock('Claude Code-credentials-first'),
            makeKeychainBlock('Claude Code-credentials-second', { raw: encodeAsciiAsHex('20240401010101Z\0') }),
            makeKeychainBlock('Claude Code-credentials-third')
        ].join('\n');

        expect(parseMacKeychainCredentialCandidates(dump)).toEqual([
            'Claude Code-credentials-second',
            'Claude Code-credentials-first',
            'Claude Code-credentials-third'
        ]);
    });
});

describe('getUsageToken', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(claudeSettings, 'getClaudeConfigDir').mockReturnValue(NON_DEFAULT_CONFIG_DIR);
        mockedExecFileSync.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        mockedExecFileSync.mockReset();
    });

    // New resolution order (usage-fetch.ts getUsageToken): config-dir-derived
    // keychain service -> config-dir-scoped credentials file -> bare service
    // (skipped when it's the same as the derived one) -> recency-based scan.

    it('prefers the config-dir-derived macOS keychain service for a non-default config dir', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
        mockCredentialsFile();
        mockedExecFileSync.mockImplementation((command: string, args?: string[]) => {
            if (command === 'security' && args?.[0] === 'find-generic-password' && args[2] === NON_DEFAULT_KEYCHAIN_SERVICE) {
                return makeTokenPayload('derived-token');
            }

            throw new Error(`Unexpected security args: ${args?.join(' ')}`);
        });

        expect(getUsageToken()).toBe('derived-token');
        expect(getUsageToken()).toBe('derived-token');
        // The very first lookup already uses the sha256-suffixed service name
        // derived from the config dir, not the bare default service.
        expect(getSecurityCallLog()).toEqual([
            `find-generic-password -s ${NON_DEFAULT_KEYCHAIN_SERVICE} -w`,
            `find-generic-password -s ${NON_DEFAULT_KEYCHAIN_SERVICE} -w`
        ]);
    });

    it('falls back to the credentials file before the bare service when the derived service misses', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
        mockCredentialsFile(makeTokenPayload('file-token'));
        mockedExecFileSync.mockImplementation((command: string, args?: string[]) => {
            if (command === 'security' && args?.[0] === 'find-generic-password' && args[2] === NON_DEFAULT_KEYCHAIN_SERVICE) {
                throw new Error('missing derived credential');
            }

            throw new Error(`Unexpected security args: ${args?.join(' ')}`);
        });

        expect(getUsageToken()).toBe('file-token');
        expect(getUsageToken()).toBe('file-token');
        // The bare 'Claude Code-credentials' service is never queried: the
        // credentials file wins as soon as the derived-service lookup misses.
        expect(getSecurityCallLog()).toEqual([
            `find-generic-password -s ${NON_DEFAULT_KEYCHAIN_SERVICE} -w`,
            `find-generic-password -s ${NON_DEFAULT_KEYCHAIN_SERVICE} -w`
        ]);
    });

    it('uses the bare macOS keychain service once for the default config dir, with no duplicate lookup', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
        vi.spyOn(claudeSettings, 'getClaudeConfigDir').mockReturnValue(DEFAULT_CONFIG_DIR);
        mockCredentialsFile(undefined, DEFAULT_CREDENTIALS_FILE);
        mockedExecFileSync.mockImplementation((command: string, args?: string[]) => {
            if (command === 'security' && args?.[0] === 'find-generic-password' && args[2] === 'Claude Code-credentials') {
                return makeTokenPayload('exact-token');
            }

            throw new Error(`Unexpected security args: ${args?.join(' ')}`);
        });

        expect(getUsageToken()).toBe('exact-token');
        expect(getUsageToken()).toBe('exact-token');
        // For the default config dir the derived service IS the bare service,
        // so it's tried once, not twice (no duplicate 'security' subprocess).
        expect(getSecurityCallLog()).toEqual([
            'find-generic-password -s Claude Code-credentials -w',
            'find-generic-password -s Claude Code-credentials -w'
        ]);
    });

    it('tries the newest hashed macOS keychain candidate after the bare service and credentials file both miss (default config dir)', () => {
        const dump = [
            makeKeychainBlock('Claude Code-credentials-old', { quoted: '20240201010101Z' }),
            makeKeychainBlock('Claude Code-credentials-new', { quoted: '20240301010101Z' })
        ].join('\n');

        vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
        vi.spyOn(claudeSettings, 'getClaudeConfigDir').mockReturnValue(DEFAULT_CONFIG_DIR);
        mockCredentialsFile(undefined, DEFAULT_CREDENTIALS_FILE);
        mockedExecFileSync.mockImplementation((command: string, args?: string[]) => {
            if (command !== 'security' || !args) {
                throw new Error(`Unexpected security args: ${args?.join(' ')}`);
            }

            if (args[0] === 'find-generic-password' && args[2] === 'Claude Code-credentials') {
                throw new Error('missing exact credential');
            }

            if (args[0] === 'dump-keychain') {
                return dump;
            }

            if (args[0] === 'find-generic-password' && args[2] === 'Claude Code-credentials-new') {
                return makeTokenPayload('hashed-token');
            }

            throw new Error(`Unexpected security args: ${args.join(' ')}`);
        });

        expect(getUsageToken()).toBe('hashed-token');
        expect(getUsageToken()).toBe('hashed-token');
        expect(getSecurityCallLog()).toEqual([
            'find-generic-password -s Claude Code-credentials -w',
            'dump-keychain',
            'find-generic-password -s Claude Code-credentials-new -w',
            'find-generic-password -s Claude Code-credentials -w',
            'dump-keychain',
            'find-generic-password -s Claude Code-credentials-new -w'
        ]);
        // The credentials file is consulted between the bare-service miss and
        // the candidate scan — the security call log alone can't see that
        // step, and the old resolution order never read the file when the
        // candidate scan succeeded.
        expect(fs.readFileSync).toHaveBeenCalledWith(DEFAULT_CREDENTIALS_FILE, 'utf8');
    });

    it('falls back through the bare service to the candidate scan when the derived service and credentials file miss (non-default config dir)', () => {
        const dump = makeKeychainBlock('Claude Code-credentials-other', { quoted: '20240301010101Z' });

        vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
        mockCredentialsFile();
        mockedExecFileSync.mockImplementation((command: string, args?: string[]) => {
            if (command !== 'security' || !args) {
                throw new Error(`Unexpected security args: ${args?.join(' ')}`);
            }

            if (args[0] === 'find-generic-password' && args[2] === NON_DEFAULT_KEYCHAIN_SERVICE) {
                throw new Error('missing derived credential');
            }

            if (args[0] === 'find-generic-password' && args[2] === 'Claude Code-credentials') {
                throw new Error('missing bare credential');
            }

            if (args[0] === 'dump-keychain') {
                return dump;
            }

            if (args[0] === 'find-generic-password' && args[2] === 'Claude Code-credentials-other') {
                return makeTokenPayload('scanned-token');
            }

            throw new Error(`Unexpected security args: ${args.join(' ')}`);
        });

        expect(getUsageToken()).toBe('scanned-token');
        // Full fallback chain for a non-default config dir: derived service,
        // credentials file (invisible to this log), bare service, then scan.
        expect(getSecurityCallLog()).toEqual([
            `find-generic-password -s ${NON_DEFAULT_KEYCHAIN_SERVICE} -w`,
            'find-generic-password -s Claude Code-credentials -w',
            'dump-keychain',
            'find-generic-password -s Claude Code-credentials-other -w'
        ]);
    });

    it('uses the credentials file on non-macOS', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        mockCredentialsFile(makeTokenPayload('linux-file-token'));

        expect(getUsageToken()).toBe('linux-file-token');
        expect(getUsageToken()).toBe('linux-file-token');
        expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
});
