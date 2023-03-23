import { createHash } from "crypto"
import { readdirSync, readFileSync, statSync } from "fs"
//import { lstat, readdir, readFile } from "fs/promises"
import { join, extname, relative } from "path"

export interface ScanOptions {
  folderPath: string
  fileTypes: string[]
  ignoredItems: string[]
}

export function scanFolder(options: ScanOptions): Map<string, string> {
  const result = new Map<string, string>()
  const { folderPath, fileTypes, ignoredItems } = options

  function scanDir(dir: string): void {
    const items = readdirSync(dir)

    for (const item of items) {
      const itemPath = join(dir, item)

      if (ignoredItems.includes(itemPath)) {
        continue
      }

      const stat = statSync(itemPath)
      if (stat.isDirectory()) {
        scanDir(itemPath)
      } else if (stat.isFile()) {
        if (fileTypes.length === 0 || fileTypes.includes(extname(item))) {
          const hash = createHash("sha256")
          const data = readFileSync(itemPath)
          hash.update(data)
          const relativePath = relative(folderPath, itemPath)
          result.set(relativePath, hash.digest("hex"))
        }
      }
    }
  }

  scanDir(folderPath)

  return result
}
