export default interface PyFileData {
  /**
   * The path of the file on the device
   */
  path: string
  /**
   * Is Directory
   */
  isDir: boolean
  /**
   * The size of the file in bytes
   */
  size: number

  /**
   * The last modified date of the file
   * @type {Date}
   * @memberof PyFileData
   * @example
   */
  lastModified?: Date

  /**
   * The creation date of the file
   * @type {Date}
   * @memberof PyFileData
   */
  created?: Date
}

// eslint-disable-next-line max-len
/* eslint @typescript-eslint/naming-convention: ["off", { "selector": "interface", "format": ["camelCase"] }] */
export interface IntermediateStats {
  creation_time: number
  modification_time: number
  size: number
  is_dir: boolean
}
