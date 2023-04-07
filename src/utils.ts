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
 * Converts the rp2 datetime format to a standard V8 Date object
 *
 * @param datetime The rp2 rtc.datetime() format: (yyyy, m, d, weekday, h, m, s, 0)
 * weekday: 0 = Monday, 1 = Tuesday, ..., 6 = Sunday
 * 0 because the rp2 does not support subseconds/milliseconds
 */
export function rp2DatetimeToDate(datetime: string): Date | null {
  const match =
    // eslint-disable-next-line max-len
    /^\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(?:\d{1,2})\)$/gm.exec(
      datetime
    )
  if (!match) {
    return null
  }

  const [, year, month, day, , hour, minute, second] = match.map(Number)
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null
  }

  return new Date(year, month - 1, day, hour, minute, second)
}

/**
 * Converts a Date object to the rp2 datetime format tuple
 *
 * @param date Normal V8 Date object
 * @returns
 */
export function dateToRp2Datetime(date: Date): string {
  const year = date.getFullYear()
  // month is 0-based but the rp2 datetime format is 1-based
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()

  return (
    `(${year}, ${month}, ${day}, ${date.getDay()}, ` +
    `${hour}, ${minute}, ${second}, 0)`
  )
}
