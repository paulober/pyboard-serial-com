import timeit

def sanitize_remote_v1(file: str | None) -> str:
    if file == "" or file == None:
        return ":" # root
    elif file[0] != ":":
        return ":" + file
    return file

def sanitize_remote_v2(files: list[str | None]) -> list[str]:
    result = []
    for file in files:
        if file == "" or file == None:
            result.append(":") # root
        elif file[0] != ":":
            result.append(":" + file)
        else:
            result.append(file)
    return result

files = ["file1.txt", "file2.txt"] * 1000

v1_time = timeit.timeit(lambda: [sanitize_remote_v1(file) for file in files], number=1000)
v2_time = timeit.timeit(lambda: sanitize_remote_v2(files), number=1000)

print(f"Version 1 took {v1_time:.6f} seconds")
print(f"Version 2 took {v2_time:.6f} seconds")