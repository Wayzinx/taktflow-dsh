import type { Metafile } from 'esbuild'

export interface BuildClientOptions {
  /** taktflow 源码根，默认 vendor/taktflow（或 TAKTFLOW_DIR）。 */
  taktflowRoot?: string
  alias?: Record<string, string>
  minify?: boolean
}

export function buildClient(options?: BuildClientOptions): Promise<{ wrapped: string; css: string; metafile: Metafile }>
