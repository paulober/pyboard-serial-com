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
}
