import { dirname, join } from "path"
import { mkdir as mkdirAsync } from "fs/promises"

/**
 * Creates the folder structure for the given files
 * 
 * @param filePaths The files to create the folder structure for
 * @param targetFolderPath The target (on the local machine) 
 * folder path (root) where all folders are created relative to (as childs)
 */
export async function createFolderStructure(
  filePaths: string[],
  localFolderPath: string
): Promise<void> {
  const folders = new Set<string>()

  for (const filePath of filePaths) {
    const folderPath = dirname(filePath)
    // remove the leading slash and append the local folder path
    folders.add(join(localFolderPath, folderPath.substring(1)))
  }

  for (const folderPath of folders) {
    await mkdirAsync(folderPath, { recursive: true })
  }
}
