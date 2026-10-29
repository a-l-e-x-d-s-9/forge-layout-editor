#!/usr/bin/env python3
"""Check the intended public Git tree without printing potentially sensitive matches."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IGNORE_DIRS = {'.git', '.venv', '__pycache__', 'node_modules', 'test-results', 'playwright-report', 'private', '.local'}
RULES = {
    'personal home path': re.compile(r'/(?:home|Users)/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+'),
    'private network address': re.compile(r'(?<![\w.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?![\w.])'),
    'GPU hardware identifier': re.compile(r'GPU-[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,}'),
    'private key material': re.compile(r'-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----'),
    'GitHub token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b'),
    'cloud access key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'Hugging Face token': re.compile(r'\bhf_[A-Za-z0-9]{25,}\b'),
    'embedded URL credential': re.compile(r'https?://[^/\s:@]+:[^/\s@]+@'),
}
EMAIL = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')
SAFE_EMAIL_DOMAINS = {'example.com', 'example.org', 'example.net', 'users.noreply.github.com'}


def candidates():
    result = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT, capture_output=True)
    if result.returncode == 0:
        return [ROOT / name for name in result.stdout.decode().split('\0') if name]
    return [path for path in ROOT.rglob('*') if path.is_file() and not IGNORE_DIRS.intersection(path.relative_to(ROOT).parts)]


def main():
    issues = []
    checked = 0
    for path in candidates():
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if path.is_symlink():
            issues.append(f'{relative}: symbolic link requires review')
            continue
        data = path.read_bytes()
        if path.suffix.lower() == '.png':
            # Preview pixels require manual review; reject metadata-bearing PNGs.
            if any(marker in data for marker in [b'tEXt', b'zTXt', b'iTXt', b'eXIf']):
                issues.append(f'{relative}: image metadata requires review')
            checked += 1
            continue
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError:
            issues.append(f'{relative}: unreviewed binary file')
            continue
        checked += 1
        for number, line in enumerate(content.splitlines(), 1):
            for label, pattern in RULES.items():
                if pattern.search(line):
                    issues.append(f'{relative}:{number}: {label}')
            if any(match.group().rsplit('@', 1)[1].lower() not in SAFE_EMAIL_DOMAINS for match in EMAIL.finditer(line)):
                issues.append(f'{relative}:{number}: non-public email address')
    if issues:
        print('Public-tree check failed. Matching values are intentionally omitted.')
        print('\n'.join(issues))
        return 1
    print(f'Public-tree check passed for {checked} files. Review preview pixels separately.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
