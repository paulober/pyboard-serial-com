from pathlib import Path
import os
import ast


def create_folder_structure(file_paths: list[str], local_folder_path: str):
    for file_path in file_paths:
        Path(os.path.join(local_folder_path, file_path.lstrip(':').lstrip('/'))).parent.mkdir(parents=True, exist_ok=True)


# allow to run expression statements in raw repl mode

class PrintWrapper(ast.NodeTransformer):
    def visit_Expr(self, node):
        if not (isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == "print"):
            new_node = ast.Expr(value=ast.Call(
                func=ast.Name(id='print', ctx=ast.Load()),
                args=[node.value],
                keywords=[]
            ))
            return new_node
        return node

def wrap_expressions_with_print(code):
    try:
        tree = ast.parse(code)
        wrapped_tree = PrintWrapper().visit(tree)
        wrapped_code = ast.unparse(wrapped_tree)
        return wrapped_code
    except Exception:
        return code


def prepend_parent_directories(folders: list[str]) -> list[str]:
    """
    aka mkdir -p for each folder in folders

    :param folders: list of folders to create recursively

    Note: this function does not create the folders, it just returns the list of folders to create with parents first
    """
    parent_dirs = set()  # Use a set to avoid duplicates
    for folder in folders:
        components = folder.split("/")
        path = ""
        for component in components:
            if component:
                path += "/" + component.lstrip("/")
                parent_dirs.add(path)
    sorted_dirs = sorted(parent_dirs)
    return sorted_dirs
