export interface PresetCheckResult {
  problems: string[]
  warnings: string[]
}

export function checkPreset(options?: { modules?: string }): Promise<PresetCheckResult>
