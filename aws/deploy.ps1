[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $AnthropicSecretArn,
    [string] $StackName = 'ai-investment-committee',
    [string] $Region = 'us-west-2'
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDirectory = Split-Path -Parent $scriptDirectory
$templatePath = Join-Path $scriptDirectory 'template.yaml'
$webDirectory = Join-Path $projectDirectory 'web'

Push-Location $scriptDirectory
sam build --template-file $templatePath
sam deploy --stack-name $StackName --region $Region --capabilities CAPABILITY_IAM --resolve-s3 --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides "AnthropicSecretArn=$AnthropicSecretArn"
Pop-Location
$outputs = aws cloudformation describe-stacks --stack-name $StackName --region $Region --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json
$outputMap = @{}; $outputs | ForEach-Object { $outputMap[$_.OutputKey] = $_.OutputValue }
aws s3 sync $webDirectory ("s3://" + $outputMap.FrontendBucketName) --delete --exclude 'config.js'
$config = "window.APP_CONFIG = Object.freeze({ apiBaseUrl: '$($outputMap.ApiUrl)' });"
$config | aws s3 cp - ("s3://" + $outputMap.FrontendBucketName + '/config.js') --content-type 'application/javascript; charset=utf-8' --cache-control 'no-store'
aws cloudfront create-invalidation --distribution-id $outputMap.DistributionId --paths '/*' | Out-Null
Write-Host "Deployment complete: $($outputMap.FrontendUrl)"
