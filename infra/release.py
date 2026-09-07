"""Build and deploy HI-SHIN using the current AWS CLI identity.

python3 infra/release.py build
python3 infra/release.py deploy IMAGE_TAG
Requires the hishin-prod-build bootstrap stack. Builds are asynchronous.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent.parent

def aws(*args):
    result = subprocess.run(['aws', '--region', 'us-east-1', *args, '--output', 'json'], cwd=root, check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else {}

def outputs(stack):
    return {item['OutputKey']: item['OutputValue'] for item in aws('cloudformation', 'describe-stacks', '--stack-name', stack)['Stacks'][0]['Outputs']}

build = outputs('hishin-prod-build')
if sys.argv[1] == 'build':
    subprocess.run([sys.executable, 'infra/package-source.py'], cwd=root, check=True)
    tag = datetime.now(timezone.utc).strftime('release-%Y%m%d-%H%M%S')
    subprocess.run(['aws', 's3', 'cp', 'infra/source.zip', f"s3://{build['SourceBucket']}/source.zip", '--only-show-errors'], cwd=root, check=True)
    result = aws('codebuild', 'start-build', '--project-name', build['BuildProject'], '--environment-variables-override', json.dumps([{'name': 'IMAGE_TAG', 'value': tag, 'type': 'PLAINTEXT'}]))
    release = {'imageTag': tag, 'imageUri': build['RepositoryUri'] + ':' + tag, 'buildId': result['build']['id']}
    (root / 'infra/deployment.json').write_text(json.dumps(release, indent=2))
    print(json.dumps(release))
elif sys.argv[1] == 'deploy':
    tag = sys.argv[2]
    parameters = {
        'VpcId': 'vpc-07f270fb994517176',
        'SubnetA': 'subnet-0bf6ebc385873551a',
        'SubnetB': 'subnet-07659f5ce6f4b2cf6',
        'HostedZoneId': 'Z01168893O6VO3L4D96NZ',
        'ImageUri': build['RepositoryUri'] + ':' + tag,
    }
    subprocess.run(['aws', '--region', 'us-east-1', 'cloudformation', 'deploy', '--stack-name', 'hishin-prod', '--template-file', 'infra/production.json', '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset', '--parameter-overrides', *[f'{k}={v}' for k,v in parameters.items()], '--tags', 'Project=HI-SHIN', 'Environment=prod'], cwd=root, check=True)
    print(json.dumps(outputs('hishin-prod')))
else:
    raise SystemExit('Expected build or deploy IMAGE_TAG')
