#!/bin/bash
# Prerequisites: 
# - Set up .aws/credentials profiles for pipeline, beta, and prod
# - Set PIPELINE_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID env variables
# - Clone repo with CloudFormation templates and CDK code locally
# - Initialize and bootstrap CDK in the Pipeline account
# - Install and configure git

# If prerequisite account values aren't set, exit
if [[ -z "${PIPELINE_ACCOUNT_ID}" || -z "${BETA_ACCOUNT_ID}" || -z "${PROD_ACCOUNT_ID}" ]]; then
  printf "Please set PIPELINE_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID\n"
  printf "PIPELINE_ACCOUNT_ID = ${PIPELINE_ACCOUNT_ID}\n"
  printf "BETA_ACCOUNT_ID = ${BETA_ACCOUNT_ID}\n"
  printf "PROD_ACCOUNT_ID = ${PROD_ACCOUNT_ID}\n"
  exit
fi

# Deploy roles without policies so the ARNs exist when the CDK Stack is deployed in parallel
printf "\nDeploying roles to BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod
    
aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod 

# First, build the CDK app
printf "\nBuilding CDK app\n"
npm install
npm audit fix
npm run build

# Clean up the cdk.out directory before starting
rm -rf cdk.out
mkdir -p cdk.out

# Deploy Pipeline CDK stack, write output to a file to gather key arn
printf "\nDeploying Cross-Account Deployment Pipeline Stack\n"
CDK_OUTPUT_FILE='.cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .cfn_outputs
npx cdk deploy PipelineDeploymentStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  --output cdk.out/pipeline \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .cfn_outputs
KEY_ARN=$(awk -F " " '/KeyArn/ { print $3 }' .cfn_outputs)

# Check that KEY_ARN is set after the CDK deployment
if [[ -z "${KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the CDK Pipeline deployment"
  exit
fi

# Deploy Frontend Pipeline
rm -rf ${CDK_OUTPUT_FILE} .cfn_outputs
npx cdk deploy FrontEndPipelineDeploymentStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  --output cdk.out/frontend-pipeline \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .cfn_outputs
FRONT_END_KEY_ARN=$(awk -F " " '/KeyArn/ { print $3 }' .cfn_outputs)

# Check that FRONT_END_KEY_ARN is set after the CDK deployment
if [[ -z "${FRONT_END_KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the Frontend CDK Pipeline deployment"
  exit
fi

# Deploy Website Pipeline - Updated with correct stack name
rm -rf ${CDK_OUTPUT_FILE} .cfn_outputs
npx cdk deploy WebsitePipelineStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  --output cdk.out/website-pipeline \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .cfn_outputs
WEBSITE_KEY_ARN=$(awk -F " " '/WebsiteArtifactBucketEncryptionKeyArn/ { print $3 }' .cfn_outputs)

# Check that WEBSITE_KEY_ARN is set after the CDK deployment
if [[ -z "${WEBSITE_KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the Website CDK Pipeline deployment"
  exit
fi

# Update the CloudFormation roles with the Key ARNs - Run these one at a time to prevent throttling
printf "\nUpdating roles with policies in BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN}

# Commit initial code to new repo (which will trigger a fresh pipeline execution)
printf "\nCommitting code to repository\n"
git add . && git commit -m "Automated Commit" && git push

# Get deployed API Gateway endpoints
printf "\nUse the following commands to get the Endpoints for deployed environments: "
printf "\n  aws cloudformation describe-stacks --stack-name Betauswest2ServiceStack \
  --profile beta | grep OutputValue"

# Get website URLs
printf "\nWebsite URLs:"
printf "\n  Beta CloudFront: $(aws cloudformation describe-stacks --stack-name WebsiteBetaus-west-2BucketStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`WebsiteURLOutput`].OutputValue' --output text)"

# Get Domain Configuration information
printf "\nDomain Configuration (Beta only):"
printf "\n  Beta Domain: $(aws cloudformation describe-stacks --stack-name WebsiteBetaus-west-2Domainqandmedating-comStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`DomainName`].OutputValue' --output text)"
printf "\n  Name Servers: $(aws cloudformation describe-stacks --stack-name WebsiteBetaus-west-2Domainqandmedating-comStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`NameServers`].OutputValue' --output text)"

# Clean up temporary files
rm -f ${CDK_OUTPUT_FILE} .cfn_outputs

# Check certificate validation status
printf "\nTo check certificate validation status (must be ISSUED before your site will work):"
printf "\naws acm list-certificates --region us-east-1 --profile beta | grep qandmedating"
printf "\naws acm describe-certificate --region us-east-1 --profile beta --certificate-arn YOUR_CERT_ARN | grep Status\n"