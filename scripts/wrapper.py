import os
import sys
import json
import pyboard as pyboard

EOO = "!!EOO!!"  # End of operation
SUPPORTED_USB_PIDS: list[int] = [
    0x0005,  # Raspberry Pi Pico MicroPython firmware (CDC)
]

try:
    # could use IOExcpetion but it checks if the serial module is installed
    from serial import SerialException
    from serial.tools import list_ports
except ImportError:
    print("!!ImportError!!")
    print("Please install pyserial")
    sys.exit(1)


##################################
######### BEGIN Utils ############
##################################

# ensure to reflect changes also to sanitize_remote_v2
def sanitize_remote(file: str | None) -> str:
    """Sanitizes the remote path to be used with pyboard.filesystem_command.

    Args:
        file (str): The remote path to sanitize.

    Returns:
        str: The sanitized remote path.
    """
    if file[0] != ":":
        return ":" + file
    elif file == "" or file == None:
        return ":"  # root
    return file


# this is a bit faster for a list of many files instead of calling sanitize_remote for each file
# ensure to reflect changes also to sanitize_remote
def sanitize_remote_v2(files: list[str | None]) -> list[str]:
    result = []
    for file in files:
        if file == "" or file == None:
            result.append(":")  # root
        elif file[0] != ":":
            result.append(":" + file)
        else:
            result.append(file)
    return result


def find_pico_ports():
    """
    Returns a list of all connected Pico devices.

    (Assumes that the Pico is running the MicroPython firmware and is connected via USB)

    0x2E8A is the vendor ID for Raspberry Pi
    """
    # TODO: maybe return more like the name or description of the device
    return [port.device for port in list_ports.comports() if port.pid in SUPPORTED_USB_PIDS and port.vid == 0x2E8A]
##################################
########## END Utils #############
##################################


class Wrapper:
    pyb: pyboard.Pyboard = None

    def __init__(self, device: str, baudrate: int = 115200):
        if device == "default":
            return

        self.pyb = pyboard.Pyboard(
            device, baudrate, wait=5, exclusive=True
        )

    def enter_raw_repl(self, soft_reset: bool = False):
        self.pyb.enter_raw_repl(soft_reset)

    def exit_raw_repl(self):
        self.pyb.exit_raw_repl()

    def list_contents(self, target: str):
        """Lists all files in the given folder.

        Args:
            target (str): The folder to list the files of.
        """
        if target[0] != ":":
            target = ":" + target
        pyboard.filesystem_command(self.pyb, ["ls", target])

    def upload_files(self, local: list[str], remote: str = None):
        """Uploads (a) file(s) to the pyboard.

        Args:
            local (str): The local path to the file(s) to upload splited by a single space.
            remote (str): The remote path to save the file to or folder to save files to.
        """
        if remote == None or remote == "":
            remote = ":"
        pyboard.filesystem_command(self.pyb, ["cp"]+local+[remote])

    def download_files(self, remote: list[str], local: str):
        """Downloads (a) files from the pyboard.

        Args:
            remote (str): The remote path to the file(s) to download splited by single space.
            local (str): The local path to save the file to or folder to save files to.
        """
        pyboard.filesystem_command(self.pyb, ["cp"]+remote+[local])

    def delete_files(self, files: list[str]):
        """Deletes (a) file(s) on the pyboard.

        Args:
            files (list[str]): The remote path(s) to the file(s) to delete
        """
        # call rm for each file
        for file in files:
            pyboard.filesystem_command(self.pyb, ["rm", file])

    def mkdirs(self, folders: list[str]):
        """Creates (a) folder(s) on the pyboard.

        Args:
            folders (list[str]): The path to the folder(s) to create on the remote host.
        """
        # call mkdir for each folder
        for folder in folders:
            pyboard.filesystem_command(self.pyb, ["mkdir", folder])

    def rmdirs(self, folders: list[str]):
        """Removes (a) folder(s) on the pyboard.

        Args:
            folders (list[str]): The path to the folder(s) to remove on the remote host.
        """
        # call rmdir for each folder
        for folder in folders:
            pyboard.filesystem_command(self.pyb, ["rmdir", folder])

    def rmdir_recursive(self, folder: str):
        """Removes a folder on the pyboard recursively.

        Args:
            folder (str): The path to the folder to remove on the remote host.
        """
        pyboard.filesystem_command(self.pyb, ["rmdir_recursive", folder])

    def exec_cmd(self, cmd: str, follow: bool = None):
        """Executes a command on the pyboard.

        Args:
            cmd (str): The command to execute.
        """
        buf = cmd.encode("utf-8")
        if follow is None or follow:
            ret, ret_err = self.pyb.exec_raw(
                buf, timeout=None, data_consumer=pyboard.stdout_write_bytes
            )
        else:
            self.pyb.exec_raw_no_follow(buf)
            ret_err = None
        if ret_err:
            self.pyb.exit_raw_repl()
            self.pyb.close()
            pyboard.stdout_write_bytes(ret_err)
            sys.exit(1)


if __name__ == "__main__":
    # accept port as argument for -p <port> and default to COM3
    import argparse

    cmd_parser = argparse.ArgumentParser(description="Run scripts on the pyboard.")
    cmd_parser.add_argument(
        "-d",
        "--device",
        default=os.environ.get("PYBOARD_DEVICE", "default"),
        help="the serial device or the IP address of the pyboard",
    )
    cmd_parser.add_argument(
        "-b",
        "--baudrate",
        default=os.environ.get("PYBOARD_BAUDRATE", "115200"),
        help="the baud rate of the serial device",
    )
    cmd_parser.add_argument(
        "--scan-ports",
        action="store_true",
        dest="scan_ports",
    )

    args = cmd_parser.parse_args()

    # open the connection to the pyboard
    try:
        if args.scan_ports:
            # scan for ports with a device from SUPPORTED_USB_PIDS and print them
            ports = find_pico_ports()
            for port in ports:
                print(port, flush=True)
            
            # mark scan as EOO
            print(EOO, flush=True)
            # exit the script after printing the ports to stdout
            exit(0)

        wrapper = Wrapper(args.device, args.baudrate)

        wrapper.enter_raw_repl(True)

        # wait for input into stdin
        while True:
            line = input()

            # check if input is json and if so, parse it
            try:
                line = json.loads(line)
            except json.decoder.JSONDecodeError:
                print("!!JSONDecodeError!!")
                continue

            if "command" not in line:
                continue

            if line["command"] == "exit":
                wrapper.pyb.close()
                exit(0)
            elif line["command"] == "status":
                # average 0.00154s
                # wrapper.exec_cmd("print('OK')", False)

                # average 0.00279s but maybe more reliable
                # as it would not affect running code or sth like that
                found = False
                for p in list_ports.comports():
                    if p.device == args.device:
                        found = True
                        break
                if not found:
                    wrapper.pyb.close()
                    raise SerialException

            elif line["command"] == "soft_reset":
                wrapper.soft_reset()

            elif line["command"] == "command" and "command" in line["args"]:
                # [5:] to remove the ".cmd " from the start of the string
                wrapper.exec_cmd(line["args"]["command"])

            elif line["command"] == "list_contents" and "target" in line["args"]:
                wrapper.list_contents(line["args"]["target"])

            #################################
            ## Download files with pyboard ##
            #################################
            elif line["command"] == "download_files" and "files" in line["args"] \
                    and "local" in line["args"]:
                if len(line["args"]["files"]) == 1:
                    wrapper.download_files(
                        [sanitize_remote(line["args"]["files"][0])], line["args"]["local"])
                else:
                    # if more files in the list, the local path is the folder to save the files to and join the files with spaces
                    # [sanitize_remote(f) for f in line["args"]["files"]] is a bit slower thant sanitize_remote_v2(line["args"]["files"])
                    wrapper.download_files(sanitize_remote_v2(
                        line["args"]["files"]), line["args"]["local"])

            #################################
            ### Upload files with pyboard ###
            #################################
            elif line["command"] == "upload_files" and "files" in line["args"] \
                    and "remote" in line["args"]:
                if len(line["args"]["files"]) == 1:
                    wrapper.upload_files([line["args"]["files"][0]],
                                         sanitize_remote(line["args"]["remote"]))
                else:
                    # if more files in the list, the remote path is the folder to save the files to and join the files with spaces
                    wrapper.upload_files(line["args"]["files"],
                                         sanitize_remote(line["args"]["remote"]))

            #################################
            ### Delete files with pyboard ###
            #################################
            elif line["command"] == "delete_files" and "files" in line["args"]:
                # no need to sanitize the files paths as they don't require to be prefixed
                # because the operation does only accept files on remote host
                wrapper.delete_files(line["args"]["files"])

            #################################
            ### Create folder with pyboard ###
            #################################
            elif line["command"] == "mkdirs" and "folders" in line["args"]:
                # no need to sanitize the folders paths as they don't require to be prefixed
                # because the operation does only accept folders on remote host
                wrapper.mkdirs(line["args"]["folders"])

            ###################################
            ### Remove folders with pyboard ###
            ###################################
            elif line["command"] == "rmdirs" and "folders" in line["args"]:
                # no need to sanitize the folders paths as they don't require to be prefixed
                # because the operation does only accept folders on remote host
                wrapper.rmdirs(line["args"]["folders"])

            ##############################################
            ### Remove folder recursively with pyboard ###
            ##############################################
            elif line["command"] == "rmtree" and "folders" in line["args"]:
                wrapper.rmdir_recursive(line["args"]["folders"][0])

            else:
                print("!!Unknown command!!", flush=True)

            sys.stdout.flush()
            print(EOO, flush=True)

    except pyboard.PyboardError as er:
        print("!!PyboardError!!")
        print(er)
        sys.exit(1)

    except KeyboardInterrupt:
        print("!!KeyboardInterrupt!!")
        sys.exit(1)

    except SerialException:
        print("!!SerialException!!")
        sys.exit(1)

    except Exception as er:
        print("!!Exception!!")
        print(er)
        sys.exit(1)

    exit(0)
