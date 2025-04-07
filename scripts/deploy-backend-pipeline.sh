#!/bin/bash
# Backend Pipeline Deployment Script
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
  exit 1
fi

# Deploy roles without policies (if not already in place)
printf "\nChecking for required roles in BETA and Prod\n"

# Check if the roles already exist
BETA_ROLE_EXISTS=$(aws cloudformation describe-stacks --profile beta --stack-name CodePipelineCrossAccountRole 2>/dev/null || echo "STACK_NOT_FOUND")
PROD_ROLE_EXISTS=$(aws cloudformation describe-stacks --profile prod --stack-name CodePipelineCrossAccountRole 2>/dev/null || echo "STACK_NOT_FOUND")

if [[ $BETA_ROLE_EXISTS == *"STACK_NOT_FOUND"* ]]; then
  printf "Creating Beta roles...\n"
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
else
  printf "Beta roles already exist. Skipping creation.\n"
fi

if [[ $PROD_ROLE_EXISTS == *"STACK_NOT_FOUND"* ]]; then
  printf "Creating Prod roles...\n"
  aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
      --stack-name CodePipelineCrossAccountRole \
      --capabilities CAPABILITY_NAMED_IAM \
      --profile prod \
      --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod
      
  aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
      --stack-name CloudFormationDeploymentRole \
      --capabilities CAPABILITY_NAMED_IAM \
      --profile prod \
      --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod
else
  printf "Prod roles already exist. Skipping creation.\n"
fi

# Build the CDK app
printf "\nBuilding CDK app\n"
npm install
npm audit fix --force || echo "Audit fix completed with warnings"
npm run build

# Clean up the cdk.out directory for backend components
rm -rf cdk.out/backend
mkdir -p cdk.out/backend

# Deploy VPC Stacks first for both environments
printf "\nDeploying VPC Stacks to Beta and Prod\n"
npx cdk deploy Betaus-west-2VPCStack \
  --profile beta \
  --require-approval never \
  --output cdk.out/beta-vpc

npx cdk deploy Produs-west-2VPCStack \
  --profile prod \
  --require-approval never \
  --output cdk.out/prod-vpc

# Deploy Backend Application Stacks
printf "\nDeploying Application Stacks to Beta and Prod\n"
npx cdk deploy Betauswest2ServiceStack \
  --profile beta \
  --require-approval never \
  --output cdk.out/beta-service

npx cdk deploy Produswest2ServiceStack \
  --profile prod \
  --require-approval never \
  --output cdk.out/prod-service

# Deploy Backend Pipeline Stack
printf "\nDeploying Backend Pipeline Stack\n"
CDK_OUTPUT_FILE='.backend_cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .backend_cfn_outputs
npx cdk deploy PipelineDeploymentStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  --output cdk.out/backend-pipeline \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .backend_cfn_outputs
KEY_ARN=$(awk -F " " '/KeyArn/ { print $3 }' .backend_cfn_outputs)

# Check that KEY_ARN is set after the CDK deployment
if [[ -z "${KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the Backend Pipeline deployment"
  exit 1
fi

# Update the CloudFormation roles with the Backend Key ARN
printf "\nUpdating roles with Backend pipeline key in BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN}

# Prompt for commit and push
printf "\nDo you want to commit and push changes to trigger the pipeline? (y/n): "
read COMMIT_RESPONSE

if [[ "$COMMIT_RESPONSE" == "y" || "$COMMIT_RESPONSE" == "Y" ]]; then
  printf "\nCommitting code to repository\n"
  git add .
  git commit -m "Automated Backend Pipeline Deployment"
  git push
  printf "\nCode committed and pushed. Pipeline should start shortly.\n"
else
  printf "\nSkipping commit. You can manually commit and push when ready.\n"
fi

# Get backend API Gateway endpoints
printf "\nBackend API Gateway Endpoints:"
printf "\n  Beta API Endpoint: $(aws cloudformation describe-stacks --stack-name Betauswest2ServiceStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text 2>/dev/null || echo "Not available")"
printf "\n  Prod API Endpoint: $(aws cloudformation describe-stacks --stack-name Produswest2ServiceStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text 2>/dev/null || echo "Not available")"

# Get additional service information
printf "\nAdditional Backend Resources:"
printf "\n  Beta VPC ID: $(aws cloudformation describe-stacks --stack-name Betaus-west-2VPCStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' --output text 2>/dev/null || echo "Not available")"
printf "\n  Prod VPC ID: $(aws cloudformation describe-stacks --stack-name