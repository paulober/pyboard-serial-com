# Description: Functions for the file system as oder control operations on the pico
from datetime import datetime

FC_IS_FILE = """\
import uos
def is_file(file_path):
    try:
        stat = uos.stat(file_path)
        return (stat[0] & 0o170000) == 0o100000
    except OSError:
        return False 
"""


FC_IS_DIR = """\
import uos
def is_dir(file_path):
    try:
        stat = uos.stat(file_path)
        return (stat[0] & 0o170000) == 0o040000
    except OSError:
        return False
"""


# no need to try expect as wrapper will handle this and return ERR const
FC_GET_FILE_INFO = """\
import uos
def get_file_info(file_path):
    stat = uos.stat(file_path)
    creation_time = stat[9]
    modification_time = stat[8]
    size = stat[6]
    print('{"creation_time": ' + str(creation_time) + ', "modification_time": ' + str(modification_time) + ', "size": ' + str(size) + ', "is_dir": ' + str((stat[0] & 0o170000) == 0o040000).lower() + '}')
"""


FC_RENAME_ITEM = """\
import uos
def rename_file(old_name, new_name):
    try:
        uos.rename(old_name, new_name)
        print('{"success": true}')
    except OSError as e:
        print('{"success": false, "error": "' + str(e) + '"}')
"""


# old set sync RTC code backup
# f"\r__pico_rtc = __import__('machine', globals()).RTC(); __pico_rtc.datetime(({now.year}, {now.month}, {now.day}, {now.weekday()}, {now.hour}, {now.minute}, {now.second}, 0))"

def FC_SYNC_RTC(now: datetime) -> str:
    return f"from machine import RTC as __pico_RTC; __pico_RTC().datetime(({now.year}, {now.month}, {now.day}, {now.weekday()}, {now.hour}, {now.minute}, {now.second}, 0)); del __pico_RTC"

# DEPRECATED
#LAMBDA_GET_RTC_TIME = "(lambda: (print(__pico_rtc.datetime())) if '__pico_rtc' in globals() and __pico_rtc else (print(__import__('machine', globals()).RTC().datetime())))()"

FC_GET_RTC_TIME = """from machine import RTC as __pico_RTC; print(__pico_RTC().datetime()); del __pico_RTC"""
