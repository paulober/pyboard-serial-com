from collections import defaultdict
import os
import sys
import json
import pyboard as pyboard
import mpyFunctions
import ast
from utils import create_folder_structure

EOO = "!!EOO!!"  # End of operation
ERR = "!!ERR!!"  # Error
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


def get_directories_to_create(file_paths):
    for file_path in file_paths:
        dir = os.path.dirname(file_path)
        yield (file_path, dir)


def fs_progress_callback(written: int, total: int):
    print(f"{{\"written\": {written}, \"total\": {total}}}", flush=True)
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

    def list_contents_recursive(self, folder: str):
        """Lists all files in the given folder and subfolders.

        Args:
            folder (str): The path to the folder to list the files of.
        """
        pyboard.filesystem_command(self.pyb, ["ls_recursive", folder])

    def upload_files(self, local: list[str], remote: str = None, local_base_dir: str = None, verbose: bool = False):
        """Uploads (a) file(s) to the pico.

        Args:
            local (str): The local path to the file(s) to upload splited by a single space.
            remote (str): The remote path to save the file to or folder to save files to.
        """
        if remote == None or remote == "":
            remote = ":"

        """
        Copy multiple files per directory:
        files_by_dir = defaultdict(list)
        for file_path in file_paths:
            dir_path = os.path.dirname(file_path)
            files_by_dir[dir_path].append(file_path)

        for dir_path, files in files_by_dir.items():
            if not os.path.exists(dir_path):
                os.makedirs(dir_path)
            custom_copy(files, dir_path)
        """

        if local_base_dir != None:
            # copy one by one; all files must be in a child directory of local_base_dir!!
            # results in a list of tuples (local full path, relative to base dir path)
            destinations: list[tuple[str, str]] = list(map(lambda x: (x, x.replace(
                local_base_dir, "/").replace('\\', '/').replace("///", "/").replace("//", "/")), local.copy()))
            destinations.sort(key=lambda x: x[1].count('/'))
            for dest in destinations:
                dir_path = os.path.dirname(dest[1])
                self.mkdirs([dir_path])
                # remate + dir_path and not remote+dest[1] because pyboard would even if only one file is uploaded
                # treat remote as directory and not as a target file name if it ends with a slash
                # remote + dir_path because dir_path is relative to the remote path
                if verbose:
                    pyboard.filesystem_command(
                        self.pyb, ["cp", dest[0], remote+dir_path+"/"],
                        progress_callback=fs_progress_callback)
                else:
                    pyboard.filesystem_command(
                        self.pyb, ["cp", dest[0], remote+dir_path+"/"])
        else:
            if verbose:
                pyboard.filesystem_command(
                    self.pyb, ["cp"]+local+[remote], progress_callback=fs_progress_callback)
            else:
                pyboard.filesystem_command(self.pyb, ["cp"]+local+[remote])

    def download_files(self, remote: list[str], local: str, verbose: bool = False):
        """Downloads (a) files from the pico.

        Args:
            remote (str): The remote path to the file(s) to download splited by single space.
            local (str): The local path to save the file to or folder to save files to.
        """

        if len(remote) > 1:
            create_folder_structure(remote, local)

            # if local is a directory, add a slash to the end
            # because pyboard would even if only one file is downloaded treat local target file name
            # if it not ends with a slash, only then it would append the filename to the local path
            if local[-1] != os.path.sep:
                local += os.path.sep

            folder_files = defaultdict(list)

            # Group files by folder
            for file_path in remote:
                folder_path, _ = file_path.rsplit('/', 1)
                folder_files[folder_path].append(file_path)

            # Call pyboard.filesystem_command for each folder and its files
            for folder_path, files in folder_files.items():
                # if local is a directory, add a slash to the end, because see above
                target = os.path.join(local, folder_path.lstrip(
                    ':').lstrip('/'))+os.path.sep
                if verbose:
                    pyboard.filesystem_command(
                        self.pyb, ["cp"] + files + [target], progress_callback=fs_progress_callback)
                else:
                    pyboard.filesystem_command(self.pyb, ["cp"] + files + [target])
        else:
            if verbose:
                pyboard.filesystem_command(
                    self.pyb, ["cp"]+remote+[local], progress_callback=fs_progress_callback)
            else:
                pyboard.filesystem_command(self.pyb, ["cp"]+remote+[local])

    def delete_files(self, files: list[str]):
        """Deletes (a) file(s) on the pico.

        Args:
            files (list[str]): The remote path(s) to the file(s) to delete
        """
        # call rm for each file
        for file in files:
            pyboard.filesystem_command(self.pyb, ["rm", file])

    def mkdirs(self, folders: list[str]):
        """Creates (a) folder(s) on the pico.

        Args:
            folders (list[str]): The path to the folder(s) to create on the remote host.
        """
        # call mkdir for each folder
        for folder in folders:
            pyboard.filesystem_command(self.pyb, ["mkdir", folder])

    def rmdirs(self, folders: list[str]):
        """Removes (a) folder(s) on the pico.

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

    def calc_file_hashes(self, files: list[str]):
        """Calculates the hashes of (a) file(s) on the pico.

        Args:
            files (list[str]): The path to the file(s) to calculate the hash of.
        """
        hashes_script = """\
import uhashlib
import ubinascii
import uos

def hash_file(file):
    try:
        if uos.stat(file)[6] > 200 * 1024:
            print(f'{{"file": "{file}", "error": "File too large"}}')
            return
        with open(file, 'rb') as f:
            h = uhashlib.sha256()
            while True:
                data = f.read(1024)
                if not data:
                    break
                h.update(data)
            print(f'{{"file": "{file}", "hash": "{ubinascii.hexlify(h.digest()).decode()}"}}')
    except Exception as e:
        print(f'{{"file": "{file}", "error": "{e.__class__.__name__}: {e}"}}')
"""
        # load function in ram on the pyboard
        self.exec_cmd(hashes_script, False)
        # call function for each file
        for file in files:
            self.exec_cmd(f"hash_file('{file}')")

    def rename_item(self, old: str, new: str):
        """Renames a file / folder on the pico.

        Args:
            items (list[str]): The path to the file(s) to rename on the remote host.
        """
        self.exec_cmd(mpyFunctions.FC_RENAME_ITEM)
        self.exec_cmd(f"rename_file('{old}', '{new}')")
        self.exec_cmd("del rename_file")

    def get_item_stat(self, item: str):
        """Gets the stat of (a) file(s) on the pico.

        Args:
            items (list[str]): The path to the file(s) to get the stat of.
        """
        self.exec_cmd(mpyFunctions.FC_GET_FILE_INFO)
        self.exec_cmd(f"get_file_info('{item}')")
        self.exec_cmd("del get_file_info")

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
            # don't want script to crash because of an error
            # self.pyb.exit_raw_repl()
            # self.pyb.close()
            # pyboard.stdout_write_bytes(ret_err)
            # sys.exit(1)

            print(ERR, flush=True)

    def exec_friendly(self, cmd: str):
        try:
            code_ast = ast.parse(cmd, mode='eval')
            wrapped_code = 'print({})'.format(cmd)
        except SyntaxError:
            wrapped_code = cmd

        buf = wrapped_code.encode("utf-8")
        ret, ret_err = self.pyb.exec_raw(
            buf, timeout=None, data_consumer=pyboard.stdout_write_bytes
        )
        if ret_err:
            pyboard.stdout_write_bytes(ret_err)

    def stop_running_stuff(self):
        # ctrl-C twice: interrupt any running program
        self.pyb.serial.write(b"\r\x03\x03")


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

            # print all at once so that when there are
            # many ports the parent don't have to buffer until it
            # has received EOO
            print("\n".join(ports)+"\n"+EOO, flush=True)

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

            elif line["command"] == "friendly_command" and "command" in line["args"]:
                wrapper.exec_friendly(line["args"]["command"])

            elif line["command"] == "double_ctrlc":
                wrapper.stop_running_stuff()

            elif line["command"] == "list_contents" and "target" in line["args"]:
                wrapper.list_contents(line["args"]["target"])

            elif line["command"] == "list_contents_recursive" and "target" in line["args"]:
                wrapper.list_contents_recursive(line["args"]["target"])

            #################################
            ## Download files with pyboard ##
            #################################
            elif line["command"] == "download_files" and "files" in line["args"] \
                    and "local" in line["args"]:
                verbose = "verbose" in line["args"] and line["args"]["verbose"] == True
                if len(line["args"]["files"]) == 1:
                    wrapper.download_files(
                        [sanitize_remote(line["args"]["files"][0])], line["args"]["local"], verbose)
                else:
                    # if more files in the list, the local path is the folder to save the files to and join the files with spaces
                    # [sanitize_remote(f) for f in line["args"]["files"]] is a bit slower thant sanitize_remote_v2(line["args"]["files"])
                    wrapper.download_files(sanitize_remote_v2(
                        line["args"]["files"]), line["args"]["local"], verbose)

            #################################
            ### Upload files with pyboard ###
            #################################
            elif line["command"] == "upload_files" and "files" in line["args"] \
                    and "remote" in line["args"]:
                verbose = "verbose" in line["args"] and line["args"]["verbose"] == True
                if "local_base_dir" in line["args"]:
                    wrapper.upload_files(line["args"]["files"], sanitize_remote(
                        line["args"]["remote"]), line["args"]["local_base_dir"], verbose=verbose)
                else:
                    wrapper.upload_files(line["args"]["files"],
                                         sanitize_remote(line["args"]["remote"]), verbose=verbose)

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

            ##############################################
            ######## Get file hashes with pyboard ########
            ##############################################
            elif line["command"] == "calc_file_hashes" and "files" in line["args"]:
                wrapper.calc_file_hashes(line["args"]["files"])

            elif line["command"] == "rename" and "item" in line["args"] and "new_name" in line["args"]["item"] and "old_name" in line["args"]["item"]:
                wrapper.rename_item(line["args"]["item"]["old_name"],
                                    line["args"]["item"]["new_name"])

            elif line["command"] == "get_item_stat" and "item" in line["args"]:
                wrapper.get_item_stat(line["args"]["item"])

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
