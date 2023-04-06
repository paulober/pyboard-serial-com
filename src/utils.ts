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

/**
 * Converts the rp2 datetime format to a Date object
 *
 * @param datetime The rp2 rtc.datetime() format: (yyyy, mm, dd, <12h>, hh, mm, ss, 0)
 * <12h> is probably the hour in 12h format -> 3 (3pm, 12h format) == 15 (15 o'clock, 24h format)
 */
export function rp2DatetimeToDate(datetime: string): Date | null {
  const match =
    // eslint-disable-next-line max-len
    /^\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(?:\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*0\)$/gm.exec(
      datetime
    )
  if (!match) {
    return null
  }

  const [, year, month, day, hour24, minute, second] = match.map(Number)
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour24 < 0 ||
    hour24 > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null
  }

  return new Date(year, month - 1, day, hour24, minute, second)
}
