#!/bin/bash
# Frontend Pipeline Deployment Script
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

# Clean up the cdk.out directory for frontend components
rm -rf cdk.out/frontend-pipeline
mkdir -p cdk.out/frontend-pipeline

# Deploy Frontend bucket stacks first
printf "\nDeploying Frontend Deployment Bucket Stacks\n"
npx cdk deploy BetaFrontEndBucketStack \
  --profile beta \
  --require-approval never \
  --output cdk.out/frontend-beta-bucket

npx cdk deploy ProdFrontEndBucketStack \
  --profile prod \
  --require-approval never \
  --output cdk.out/frontend-prod-bucket

# Deploy Device Farm Stack for Beta
printf "\nDeploying Device Farm Stack for Beta\n"
npx cdk deploy BetaFrontEndDeviceFarmStack \
  --profile beta \
  --require-approval never \
  --output cdk.out/frontend-beta-devicefarm

# Deploy Device Farm Stack for Prod
printf "\nDeploying Device Farm Stack for Prod\n"
npx cdk deploy ProdFrontEndDeviceFarmStack \
  --profile prod \
  --require-approval never \
  --output cdk.out/frontend-prod-devicefarm

# Deploy Frontend Pipeline Stack
printf "\nDeploying Frontend Pipeline Stack\n"
CDK_OUTPUT_FILE='.frontend_cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .frontend_cfn_outputs
npx cdk deploy FrontEndPipelineDeploymentStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  --output cdk.out/frontend-pipeline \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .frontend_cfn_outputs
FRONT_END_KEY_ARN=$(awk -F " " '/KeyArn/ { print $3 }' .frontend_cfn_outputs)

# Check that FRONT_END_KEY_ARN is set after the CDK deployment
if [[ -z "${FRONT_END_KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the Frontend CDK Pipeline deployment"
  exit 1
fi

# Update the CloudFormation roles with the Frontend Key ARN
printf "\nUpdating roles with Frontend pipeline key in BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta FrontEndKeyArn=${FRONT_END_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta FrontEndKeyArn=${FRONT_END_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod FrontEndKeyArn=${FRONT_END_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod FrontEndKeyArn=${FRONT_END_KEY_ARN}

# Prompt for commit and push
printf "\nDo you want to commit and push changes to trigger the pipeline? (y/n): "
read COMMIT_RESPONSE

if [[ "$COMMIT_RESPONSE" == "y" || "$COMMIT_RESPONSE" == "Y" ]]; then
  printf "\nCommitting code to repository\n"
  git add .
  git commit -m "Automated Frontend Pipeline Deployment"
  git push
  printf "\nCode committed and pushed. Pipeline should start shortly.\n"
else
  printf "\nSkipping commit. You can manually commit and push when ready.\n"
fi

# Get Frontend resources information
printf "\nFrontend Resources Information:"

# Device Farm Project ARNs
printf "\n  Beta Device Farm Project: $(aws cloudformation describe-stacks --stack-name BetaFrontEndDeviceFarmStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`DeviceFarmProjectArn`].OutputValue' --output text 2>/dev/null || echo "Not available")"

printf "\n  Prod Device Farm Project: $(aws cloudformation describe-stacks --stack-name ProdFrontEndDeviceFarmStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`DeviceFarmProjectArn`].OutputValue' --output text 2>/dev/null || echo "Not available")"

# Frontend deployment buckets
printf "\n  Beta Frontend Bucket: $(aws cloudformation describe-stacks --stack-name BetaFrontEndBucketStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text 2>/dev/null || echo "Not available")"

printf "\n  Prod Frontend Bucket: $(aws cloudformation describe-stacks --stack-name ProdFrontEndBucketStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text 2>/dev/null || echo "Not available")"

# Clean up temporary files
rm -f ${CDK_OUTPUT_FILE} .frontend_cfn_outputs

printf "\n=== Frontend Pipeline Deployment Complete ===\n"
printf "The frontend pipeline has been deployed and will automatically build and deploy your mobile app when code is pushed to the repository.\n"
printf "Device Farm testing will be triggered as part of the pipeline process.\n"