import type PyFileData from "./pyfileData"

export enum PyOutType {
    none,
    portsScan,
    command,
    listContents,
    fsOps
}

export interface PyOut {
    type: PyOutType
}

export interface PyOutCommand extends PyOut {
    type: PyOutType.command
    response: string
}

export interface PyOutListContents extends PyOut {
    type: PyOutType.listContents
    response: PyFileData[]
}

export interface PyOutFsOps extends PyOut {
    type: PyOutType.fsOps,
    status: boolean
}

export interface PyOutPortsScan extends PyOut {
    type: PyOutType.portsScan
    ports: string[]
}
