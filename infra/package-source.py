"""Package only build inputs. Never send credentials, local data or personal videos."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
with ZipFile(root / 'infra/source.zip', 'w', ZIP_DEFLATED) as archive:
    for name in ['Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'jest.config.js']:
        archive.write(root / name, name)
    for folder in ['src', 'ui', 'tests', 'scripts', 'eval']:
        for path in (root / folder).rglob('*'):
            if not path.is_file() or any(part in ['node_modules', 'dist', '.git'] for part in path.parts):
                continue
            if path.suffix not in ['.ts', '.tsx', '.js', '.json', '.html', '.css']:
                continue
            archive.write(path, str(path.relative_to(root)))
print('Created infra/source.zip (code only)')
