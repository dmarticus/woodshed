import ast
import json
import sys


def literal_dependency(node):
    return (
        isinstance(node, ast.Tuple)
        and len(node.elts) == 2
        and all(isinstance(item, ast.Constant) and isinstance(item.value, str) for item in node.elts)
    )


def dependency_assignment(source):
    tree = ast.parse(source)
    migrations = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Migration"]
    if len(migrations) != 1:
        raise ValueError("Expected exactly one Migration class")
    assignments = {}
    for node in migrations[0].body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments[target.id] = node.value
    if "replaces" in assignments or "run_before" in assignments:
        raise ValueError("Squashed migrations and run_before need explicit review")
    dependencies = assignments.get("dependencies")
    if not isinstance(dependencies, (ast.List, ast.Tuple)):
        raise ValueError("Migration dependencies must be a literal list or tuple")
    for node in dependencies.elts:
        swappable = (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "migrations"
            and node.func.attr == "swappable_dependency"
            and len(node.args) == 1
            and not node.keywords
            and isinstance(node.args[0], ast.Attribute)
            and isinstance(node.args[0].value, ast.Name)
            and node.args[0].value.id == "settings"
            and node.args[0].attr == "AUTH_USER_MODEL"
        )
        if not literal_dependency(node) and not swappable:
            raise ValueError("Dynamic migration dependencies need explicit graph validation")
    return dependencies


def literal_dependencies(dependencies):
    for node in dependencies.elts:
        if literal_dependency(node):
            yield node.elts[0].value, node.elts[1]


def rebase(request):
    sources = request["sources"]
    first = dependency_assignment(sources[0]["content"])
    labels = [label for label, name in literal_dependencies(first) if name.value == request["common"]]
    if len(labels) != 1:
        raise ValueError("Cannot unambiguously identify the PR migration's app and common parent")
    app = labels[0]
    output = []
    parent = request["common"]
    next_parent = request["baseTip"]
    for source in sources:
        dependencies = dependency_assignment(source["content"])
        own = [(label, node) for label, node in literal_dependencies(dependencies) if label == app]
        if len(own) != 1 or own[0][1].value != parent:
            raise ValueError("Only a linear, PR-added migration chain can be rebased automatically")
        node = own[0][1]
        lines = source["content"].encode().splitlines(keepends=True)
        start = sum(map(len, lines[: node.lineno - 1])) + node.col_offset
        end = sum(map(len, lines[: node.end_lineno - 1])) + node.end_col_offset
        original = source["content"].encode()
        literal = original[start:end]
        if len(literal) < 2 or literal[:1] not in (b"'", b'"') or literal[-1:] != literal[:1]:
            raise ValueError("Unsupported dependency string literal")
        replacement = literal[:1] + next_parent.encode() + literal[-1:]
        content = (original[:start] + replacement + original[end:]).decode()
        ast.parse(content)
        output.append({"from": source["from"], "to": source["to"], "content": content})
        parent = source["oldName"]
        next_parent = source["newName"]
    return {"app": app, "files": output}


if __name__ == "__main__":
    try:
        print(json.dumps(rebase(json.load(sys.stdin))))
    except (ValueError, KeyError, SyntaxError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
