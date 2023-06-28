# Description: Functions for the file system as oder control operations on the pico
from datetime import datetime

# NOTE: use __pico_ prefix to avoid name collisions with user code

FC_IS_FILE = """\
import uos
def __pico_is_file(file_path):
    try:
        stat = uos.stat(file_path)
        return (stat[0] & 0o170000) == 0o100000
    except OSError:
        return False 
"""
def CALL_IS_FILE(file_path: str) -> str:
    return f"__pico_is_file('{file_path}')"
DEL_IS_FILE = "del __pico_is_file"


FC_IS_DIR = """\
import uos
def __pico_is_dir(file_path):
    try:
        stat = uos.stat(file_path)
        return (stat[0] & 0o170000) == 0o040000
    except OSError:
        return False
"""
def CALL_IS_DIR(file_path: str) -> str:
    return f"__pico_is_dir('{file_path}')"
DEL_IS_DIR = "del __pico_is_dir"


# no need to try expect as wrapper will handle this and return ERR const
FC_GET_FILE_INFO = """\
import uos
def __pico_get_file_info(file_path):
    stat = uos.stat(file_path)
    creation_time = stat[9]
    modification_time = stat[8]
    size = stat[6]
    print('{"creation_time": ' + str(creation_time) + ', "modification_time": ' + str(modification_time) + ', "size": ' + str(size) + ', "is_dir": ' + str((stat[0] & 0o170000) == 0o040000).lower() + '}')
"""
def CALL_GET_FILE_INFO(file_path: str) -> str:
    return f"__pico_get_file_info('{file_path}')"
DEL_GET_FILE_INFO = "del __pico_get_file_info"


FC_RENAME_ITEM = """\
import uos
def __pico_rename_file(old_name, new_name):
    try:
        uos.rename(old_name, new_name)
        print('{"success": true}')
    except OSError as e:
        print('{"success": false, "error": "' + str(e) + '"}')
"""
def CALL_RENAME_ITEM(old_name: str, new_name: str) -> str:
    return f"__pico_rename_file('{old_name}', '{new_name}')"
DEL_RENAME_ITEM = "del __pico_rename_file"


# old set sync RTC code backup
# f"\r__pico_rtc = __import__('machine', globals()).RTC(); __pico_rtc.datetime(({now.year}, {now.month}, {now.day}, {now.weekday()}, {now.hour}, {now.minute}, {now.second}, 0))"

def EXEC_SYNC_RTC(now: datetime) -> str:
    return f"from machine import RTC as __pico_RTC; __pico_RTC().datetime(({now.year}, {now.month}, {now.day}, {now.weekday()}, {now.hour}, {now.minute}, {now.second}, 0)); del __pico_RTC"

# DEPRECATED
# LAMBDA_GET_RTC_TIME = "(lambda: (print(__pico_rtc.datetime())) if '__pico_rtc' in globals() and __pico_rtc else (print(__import__('machine', globals()).RTC().datetime())))()"

EXEC_GET_RTC_TIME = """from machine import RTC as __pico_RTC; print(__pico_RTC().datetime()); del __pico_RTC"""


FC_HASH_FILE = """\
import uhashlib
import ubinascii
import uos
import ujson

def __pico_hash_file(file):
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
def CALL_HASH_FILE(file: str) -> str:
    return f"__pico_hash_file('{file}')"
DEL_HASH_FILE = "del __pico_hash_file"
