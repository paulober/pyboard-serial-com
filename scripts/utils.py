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

