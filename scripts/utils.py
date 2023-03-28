from pathlib import Path
import os


def create_folder_structure(file_paths: list[str], local_folder_path: str):
    for file_path in file_paths:
        Path(os.path.join(local_folder_path, file_path.lstrip(':').lstrip('/'))).parent.mkdir(parents=True, exist_ok=True)
