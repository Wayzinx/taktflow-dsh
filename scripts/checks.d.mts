export const CLIENT_REQUIRE_ALLOWLIST: readonly string[]

export const FORBIDDEN_CLIENT_PREFIX: string

export function extractRequires(code: string): string[]

export function checkClientBundle(code: string): string[]

export function checkHostBundle(code: string): string[]

export function wrapClientBundle(clientCode: string, css: string): string

export function checkPackageManifest(manifest: unknown): string[]
