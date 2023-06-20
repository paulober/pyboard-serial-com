from collections import defaultdict
import os
import sys
import json
import pyboard as pyboard
import mpyFunctions
import ast
from utils import create_folder_structure, wrap_expressions_with_print, prepend_parent_directories
import threading
import time
import signal
import platform
from datetime import datetime
from typing import Optional, Union

EOO = "!!EOO!!"  # End of operation
ERR = "!!ERR!!"  # Error
SIMPLE_AUTO_COMP = "!!SIMPLE_AUTO_COMP!!"  # Simple auto completion
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


# usage of Optional as str | None is not supported by Python 3.9
def sanitize_remote(file: Optional[str]) -> str:
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
def sanitize_remote_v2(files: list[Optional[str]]) -> list[str]:
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
    try:
        return [port.device for port in list_ports.comports() if port.pid in SUPPORTED_USB_PIDS and port.vid == 0x2E8A]
    except Exception:
        devs = list_ports.comports()
        if len(devs) > 0:
            return [devs[0].device]
        return []


def get_directories_to_create(file_paths):
    for file_path in file_paths:
        dir = os.path.dirname(file_path)
        yield (file_path, dir)


fsop_current_file_pos = -1
fsop_total_files_count = -1
fsop_last_pos = -1
def fs_progress_callback(written: int, total: int):
    global fsop_last_pos, fsop_current_file_pos
    if written == -1 and total == -1:
        fsop_current_file_pos += 1
        return
    
    # reduce prints so stdin buffer of parent does not get overloaded
    # but now the progress % cannot be calculated by parent as it gets only notified by new file
    #and written != total <- for a few more prints
    if fsop_last_pos == fsop_current_file_pos:
        return
    fsop_last_pos = fsop_current_file_pos

    """
    Needs to be very fast, otherwise multiple json dumps could arrive at the same time at the parent process if files are small.
    """
    #payload = { "written": written, "total": total }
    #if fsop_current_file_pos != -1 and fsop_total_files_count >= fsop_current_file_pos:
    #    payload["currentFilePos"] = fsop_current_file_pos
    #    payload["totalFilesCount"] = fsop_total_files_count
    print(f"{{\"written\": {written}, \"total\": {total}, \"currentFilePos\": {fsop_current_file_pos}, \"totalFilesCount\": {fsop_total_files_count}}}", flush=True)


if platform.system() == "Windows":
    import msvcrt

    def clear_stdin():
        # does only work in cmd or ps1 like environments
        while msvcrt.kbhit():
            msvcrt.getch()
else:
    import select

    def clear_stdin():
        stdin_fd = sys.stdin.fileno()
        while select.select([stdin_fd], [], [], 0.0)[0]:
            os.read(stdin_fd, 4096)


def listen_stdin(stop_event: threading.Event):
    while not stop_event.is_set():
        # readline is aceptable MicroPython does not
        # support listening for single chars
        data = sys.stdin.buffer.readline()

        # speed up return after __SENTINEL__ was sent
        if stop_event.is_set():
            return None

        if data:
            data = data.strip()
            if data != "":
                return data+b"\r"

        # reduce cpu load cause by stdin polling in this runtime thread
        time.sleep(0.01)
    return b''
##################################
########## END Utils #############
##################################


class Wrapper:
    pyb: pyboard.Pyboard = None
    friendly: bool = False

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

    def disconnect(self):
        # self.stop_running_stuff()
        self.pyb.close()

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
        """Upload files to the Pico.

        Args:
            local (list[str]): The local paths to the files to upload.
            remote (str): The remote path to save the files relative to.
        """
        global fsop_current_file_pos, fsop_total_files_count, fsop_last_pos
        
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
        fsop_total_files_count = len(local)

        if local_base_dir != None:
            # copy one by one; all files must be in a child directory of local_base_dir!!
            # results in a list of tuples (local full path, relative to base dir path)
            destinations: list[tuple[str, str]] = list(map(lambda x: (x, x.replace(
                local_base_dir, "/").replace('\\', '/').replace("///", "/").replace("//", "/")), local.copy()))
            destinations.sort(key=lambda x: x[1].count('/'))
            for dest in destinations:
                dir_path = os.path.dirname(dest[1])
                # pyboard fs_mkdir has been modified so it don't cause any error if the directory already exists
                # so that all errors thrown here will indicate to the parent that a file upload failed
                self.mkdirs([dir_path])
                # remate + dir_path and not remote+dest[1] because pyboard would even if only one file is uploaded
                # treat remote as directory and not as a target file name if it ends with a slash
                # remote + dir_path because dir_path is relative to the remote path
                if verbose:
                    fsop_current_file_pos = destinations.index(dest) + 1
                    pyboard.filesystem_command(
                        self.pyb, ["cp", dest[0], remote+dir_path+"/"],
                        progress_callback=fs_progress_callback)
                else:
                    pyboard.filesystem_command(
                        self.pyb, ["cp", dest[0], remote+dir_path+"/"])
        else:
            if verbose:
                pyboard.filesystem_command(
                    self.pyb, ["cp"]+local+[remote], progress_callback=fs_progress_callback, auto_pos_incr=True)
            else:
                pyboard.filesystem_command(self.pyb, ["cp"]+local+[remote])
        fsop_total_files_count = -1
        fsop_current_file_pos = -1
        fsop_last_pos = -1

    def download_files(self, remote: list[str], local: str, verbose: bool = False):
        """Downloads (a) files from the pico.

        Args:
            remote (str): The remote path to the file(s) to download splited by single space.
            local (str): The local path to save the file to or folder to save files to.
        """
        global fsop_current_file_pos, fsop_total_files_count, fsop_last_pos

        fsop_total_files_count = len(remote)

        if len(remote) > 1:
            create_folder_structure(remote, local)

            # if local is a directory, add a slash to the end
            # because pyboard would even if only one file is downloaded treat local target file name
            # if it not ends with a slash, only then it would append the filename to the local path
            if local[-1] != os.path.sep:
                local += os.path.sep

            folder_files: dict[str: list[str]] = defaultdict(list)

            # Group files by folder
            for file_path in remote:
                folder_path, _ = file_path.rsplit('/', 1)
                folder_files[folder_path].append(file_path)

            fsop_current_file_pos = 0
            # Call pyboard.filesystem_command for each folder and its files
            for folder_path, files in folder_files.items():
                # if local is a directory, add a slash to the end, because see above
                target = os.path.join(local, folder_path.lstrip(
                    ':').lstrip('/'))+os.path.sep
                if verbose:
                    pyboard.filesystem_command(
                        self.pyb, ["cp"] + files + [target], progress_callback=fs_progress_callback, auto_pos_incr=True)
                else:
                    pyboard.filesystem_command(self.pyb, ["cp"] + files + [target])
        else:
            if verbose:
                pyboard.filesystem_command(
                    self.pyb, ["cp"]+remote+[local], progress_callback=fs_progress_callback, auto_pos_incr=True)
            else:
                pyboard.filesystem_command(self.pyb, ["cp"]+remote+[local])
        fsop_total_files_count = -1
        fsop_current_file_pos = -1
        fsop_last_pos = -1

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
        folders = prepend_parent_directories(folders)
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

    def rm_file_or_dir(self, path: str, recursive: bool):
        """Removes a file or folder on the pyboard.

        Args:
            path (str): The path to the file or folder to remove on the remote host.
        """
        self.pyb.exec_raw(mpyFunctions.FC_IS_DIR)

        ret, err = self.pyb.exec_raw(f"print('D' if __pico_is_dir('{path}') else 'F')")
        if err:
            print(ERR, flush=True)
        else:
            is_dir = ret.decode().strip() == 'D'
            if is_dir:
                if recursive:
                    pyboard.filesystem_command(self.pyb, ["rmdir_recursive", path])
                else:
                    pyboard.filesystem_command(self.pyb, ["rmdir", path])
            else:
                pyboard.filesystem_command(self.pyb, ["rm", path])

        self.pyb.exec_raw("del __pico_is_dir")

    def calc_file_hashes(self, files: list[str]):
        """Calculates the hashes of (a) file(s) on the pico.

        Args:
            files (list[str]): The path to the file(s) to calculate the hash of.
        """
        hashes_script = """\
import uhashlib
import ubinascii
import uos
import ujson

def hash_file(file):
    try:
        if uos.stat(file)[6] > 200 * 1024:
            print(ujson.dumps({"file": file, "error": "File too large"}))
            return
        with open(file, 'rb') as f:
            h = uhashlib.sha256()
            while True:
                data = f.read(512)
                if not data:
                    break
                h.update(data)
            print(ujson.dumps({"file": file, "hash": ubinascii.hexlify(h.digest()).decode()}))
    except Exception as e:
        print(ujson.dumps({"file": file, "error": f"{e.__class__.__name__}: {e}"}))
"""
        # load function in ram on the pyboard
        self.exec_cmd(hashes_script, False)
        # call function for each file
        for file in files:
            self.exec_cmd(f"hash_file('{file}'); del hash_file")

    def rename_item(self, old: str, new: str):
        """Renames a file / folder on the Pico (W).

        Args:
            old (str): The old/current path to the file / folder.
            new (str): The new/target path to the file / folder.
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

    def exec_cmd(self, cmd: Union[str, bytes], follow: Optional[bool] = None, full_output: bool = False):
        """Executes a command on the pyboard.

        Args:
            cmd (str): The command to execute.
        """
        buf: bytes = cmd.encode("utf-8") if isinstance(cmd, str) else cmd
        if follow is None or follow:
            _, ret_err = self.pyb.exec_raw(
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
            if full_output:
                print(ret_err.decode("utf-8"), flush=True)
            else:
                print(ERR, flush=True)

    def exec_friendly_cmd(self, cmd: Union[str, bytes]):
        """Executes a command on the pyboard.

        Args:
            cmd (str): The command to execute.
        """
        stop_event = threading.Event()
        stdio_thread = threading.Thread(target=redirect_stdin, args=(stop_event, self,))
        # Set as a daemon thread to exit when the main program exits
        stdio_thread.daemon = True
        buf: bytes = cmd if isinstance(cmd, bytes) else wrap_expressions_with_print(
            cmd).encode("utf-8")
        stdio_thread.start()

        _, err = self.pyb.exec_raw(
            buf, timeout=None, data_consumer=pyboard.stdout_write_bytes)

        # stop the thread
        stop_event.set()
        # workarount to make stdin.readline return and check for stop_event
        sys.stdout.write("!!__SENTINEL__!!")
        sys.stdout.flush()
        stdio_thread.join()
        if err:
            print(err.decode("utf-8"), flush=True)

    def run_file(self, filename: str):
        """Runs a file on the pyboard.

        Args:
            file (str): The path to the file to run on the remote host.
        """
        try:
            with open(filename, "rb") as f:
                pyfile = f.read()
                if filename.endswith(".mpy") and pyfile[0] == ord("M"):
                    self.pyb.exec_("_injected_buf=" + repr(pyfile))
                    pyfile = pyboard._injected_import_hook_code
                self.exec_friendly_cmd(pyfile)

        except:
            print(ERR, flush=True)

    def sync_rtc(self):
        """Syncs the RTC on the pyboard with the PC's RTC."""
        # exec without data_consumer, also to set it as fast as possible
        _, err = self.pyb.exec_raw("\r"+mpyFunctions.FC_SYNC_RTC(datetime.now()))
        if err:
            print(ERR, flush=True)

    def get_rtc_time(self):
        """Gets the RTC time on the pyboard."""
        ret, err = self.pyb.exec_raw("\r"+mpyFunctions.FC_GET_RTC_TIME)
        if err:
            print(ERR, flush=True)
        else:
            print(ret.decode("utf-8"), flush=True)

    def reboot(self, verbose: bool = False):
        """
        Reboots the pyboard.
        """
        self.stop_running_stuff()
        cmd = "\rimport machine; machine.reset()"
        # verbose does not work
        if verbose:
            self.pyb.exec(cmd, data_consumer=pyboard.stdout_write_bytes,
                          silent_fail=True)
        else:
            self.pyb.exec(cmd, silent_fail=True)
        # unreachable code
        # time.sleep(1.0)
        # self.pyb.enter_raw_repl(False)

    def soft_reset(self):
        """
        Soft resets the pyboard.
        """
        self.stop_running_stuff()
        self.pyb.exit_raw_repl()
        self.pyb.enter_raw_repl(True)
        time.sleep(0.1)

    def stop_running_stuff(self):
        # ctrl-C twice: interrupt any running program
        self.pyb.serial.write(b"\r\x03\x03")

    def retrieve_tab_completion(self, line: str):
        cmd_bin = line.encode("utf-8")
        wrapper.pyb.serial.write(b"\x02")
        wrapper.pyb.serial.flush()
        # normally friendly repl prompt needs about 0.00007s to arrive (at worst)
        time.sleep(0.002)
        # throw friendly REPL prompt in the void
        wrapper.pyb.serial.reset_input_buffer()
        # send cmd
        wrapper.pyb.serial.write(cmd_bin)
        # reconfigure serial port timeout (and store current timeout value)
        # timeout needed because otherwise read_until() will block forever (if no tab-completion is available)
        prev_timeout = wrapper.pyb.serial.timeout
        wrapper.pyb.serial.timeout = 0.1
        # send tab command
        wrapper.pyb.serial.write(b"\t")
        # read until first newline (if its a simple autocompletion it will wait for the timeout)
        val = wrapper.pyb.serial.read_until(expected=b"\r\n")
        # +2 for newline and carriage return expected above | if no completion avail
        # it will be returned as mutliline
        if len(val) > len(cmd_bin)+2:
            # > simple tab-completion available
            sys.stdout.write(SIMPLE_AUTO_COMP+val.decode("utf-8")+"\n")
        else:
            # > multiline tab-completion available
            sys.stdout.write(wrapper.pyb.serial.read_until(expected=cmd_bin)[:-len(cmd_bin)-4].decode("utf-8"))
        # clear line so enter_raw_repl() will work
        wrapper.pyb.serial.write(b"\x03")
        # put REPl back into raw mode
        wrapper.enter_raw_repl(False)
        # restore previous timeout
        wrapper.pyb.serial.timeout = prev_timeout


# Define the serial port reading function
def read_serial_port(stop_event: threading.Event):
    while not stop_event.is_set():
        try:
            n = wrapper.pyb.serial.inWaiting()
        except OSError as er:
            if er.args[0] == 5:  # IO error, device disappeared
                print("device disconnected")
                break

        if n > 0:
            c = wrapper.pyb.serial.read(1)
            if c is not None:
                # pass character through to the console
                oc = ord(c)
                if oc in (8, 9, 10, 13, 27) or 32 <= oc <= 126:
                    sys.stdout.write(c.decode("utf-8"))
                    sys.stdout.flush()
                else:
                    sys.stdout.write((b"[%02x]" % ord(c)).decode("utf-8"))
                    sys.stdout.flush()

        # Add a small delay to reduce CPU usage
        time.sleep(0.01)


def redirect_stdin(stop_event: threading.Event, wrapper: Wrapper):
    while not stop_event.is_set():
        c = listen_stdin(stop_event)

        if stop_event.is_set():
            break

        if c == b"\x1d":  # ctrl-], quit
            pass
        elif c == "\x04":  # ctrl-D, end of file
            pass
        elif c:  # Only write to the serial port if there is data available
            if wrapper.pyb.serial.is_open:
                wrapper.pyb.serial.write(c)

        # Add a small delay to reduce CPU usage
        time.sleep(0.01)


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
    cmd_parser.add_argument(
        "--friendly-repl",
        action="store_true",
        dest="friendly",
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

        if args.device == "default":
            sys.exit(0x12F9)

        wrapper = Wrapper(args.device, args.baudrate)

        # register a signal handler to responsible close the os handle for the port
        signal.signal(signal.SIGINT, lambda s, f: wrapper.disconnect())

        # enter raw repl (better for programmatic use, aka bot chating with bot)
        wrapper.enter_raw_repl(True)

        # enable frindly repl on start-up if requested
        if args.friendly:
            wrapper.friendly = True
            wrapper.pyb.exit_raw_repl()

        # wait for input into stdin
        while True:
            # frendly REPL loop (ctrl-] to exit)
            if wrapper.friendly:
                # Set up an event object to signal the thread to stop
                stop_event = threading.Event()
                # Set up the thread to read the serial port
                serial_thread = threading.Thread(
                    target=read_serial_port, args=(stop_event,))
                # Set as a daemon thread to exit when the main program exits
                serial_thread.daemon = True

                # catch raw repl entry/prompt
                wrapper.pyb.serial.read(1)

                serial_thread.start()

                while True:
                    c = listen_stdin(None)
                    if c == b"\x1d":  # ctrl-], quit
                        break
                    elif c == "\x04":  # ctrl-D, end of file
                        pass
                    else:
                        wrapper.pyb.serial.write(c)

                    # Add a small delay to reduce CPU usage
                    time.sleep(0.01)

                # Signal the thread to stop and wait for it to terminate
                stop_event.set()
                serial_thread.join()

                # reset friendly flag
                wrapper.friendly = False

                # stop running stuff if user started something and
                # then exited friendly mode by ctrl-] with it sent to
                # the board could cause problems
                wrapper.stop_running_stuff()

                # TODO: raw repl entry will print to user and cause a JSONDecodeError
                wrapper.pyb.enter_raw_repl(False)

            line = input()

            # check if input is json and if so, parse it
            try:
                line = json.loads(line)
            except json.decoder.JSONDecodeError:
                print("!!JSONDecodeError!!", flush=True)
                continue

            if "command" not in line:
                continue

            if line["command"] == "exit":
                wrapper.pyb.close()
                exit(0)

            elif line["command"] == "status":
                # not connection this will rais a serial exception
                wrapper.pyb.exec_raw("print('OK')".encode("utf-8"), 5)

            elif line["command"] == "sync_rtc":
                wrapper.sync_rtc()

            elif line["command"] == "get_rtc_time":
                wrapper.get_rtc_time()

            elif line["command"] == "soft_reset":
                wrapper.soft_reset()

            elif line["command"] == "hard_reset":
                wrapper.reboot()

            elif line["command"] == "command" and "command" in line["args"]:
                # [5:] to remove the ".cmd " from the start of the string
                interactive = "interactive" in line["args"] and line["args"]["interactive"]
                if interactive:
                    wrapper.exec_friendly_cmd(line["args"]["command"].encode("utf-8"))
                    clear_stdin()
                else:
                    wrapper.exec_cmd(line["args"]["command"])

            elif line["command"] == "friendly_code" and "code" in line["args"]:
                wrapper.exec_friendly_cmd(line["args"]["code"])
                # clear full stdin buffer
                clear_stdin()

            elif line["command"] == "retrieve_tab_comp" and "code" in line["args"]:
                wrapper.retrieve_tab_completion(line["args"]["code"])

            elif line["command"] == "run_file" and "files" in line["args"]:
                wrapper.run_file(line["args"]["files"][0])
                # clear full stdin buffer
                clear_stdin()

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

            ####################################################
            # Remove file or folder (recursively) with pyboard #
            ####################################################
            elif line["command"] == "rm_file_or_dir" and "target" in line["args"]:
                recursive = "recursive" in line["args"] and line["args"]["recursive"] == True
                wrapper.rm_file_or_dir(line["args"]["target"], recursive)

            ##############################################
            ######## Get file hashes with pyboard ########
            ##############################################
            elif line["command"] == "calc_file_hashes" and "files" in line["args"]:
                wrapper.calc_file_hashes(line["args"]["files"])

            elif line["command"] == "rename" and "item" in line["args"] and "target" in line["args"]:
                wrapper.rename_item(line["args"]["item"], line["args"]["target"])

            elif line["command"] == "get_item_stat" and "item" in line["args"]:
                wrapper.get_item_stat(line["args"]["item"])

            elif line["command"] == "get_friendly":
                wrapper.friendly = True
                wrapper.pyb.exit_raw_repl()

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
