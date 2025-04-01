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
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta &

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta &

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod &
    
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

# Deploy Website Bucket stacks to both environments
printf "\nDeploying Website Bucket Stacks to Beta and Prod\n"
npx cdk deploy WebsiteBetaus-west-2BucketStack \
  --profile beta \
  --require-approval never

npx cdk deploy WebsiteProdus-west-2BucketStack \
  --profile prod \
  --require-approval never

# Deploy Domain Configuration stack (only for Beta)
printf "\nDeploying Domain Configuration Stack to Beta\n"
npx cdk deploy WebsiteBetaus-west-2Domainqandmedating-comStack \
  --profile beta \
  --require-approval never

# Deploy Pipeline CDK stack, write output to a file to gather key arn
printf "\nDeploying Cross-Account Deployment Pipeline Stack\n"
CDK_OUTPUT_FILE='.cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .cfn_outputs
npx cdk deploy PipelineDeploymentStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
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
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .cfn_outputs
WEBSITE_KEY_ARN=$(awk -F " " '/WebsiteArtifactBucketEncryptionKeyArn/ { print $3 }' .cfn_outputs)

# Check that WEBSITE_KEY_ARN is set after the CDK deployment
if [[ -z "${WEBSITE_KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the Website CDK Pipeline deployment"
  exit
fi

# Update the CloudFormation roles with the Key ARNs in parallel
printf "\nUpdating roles with policies in BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN} &

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN} &

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} FrontEndKeyArn=${FRONT_END_KEY_ARN} WebsiteKeyArn=${WEBSITE_KEY_ARN} &

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
printf "\n  aws cloudformation describe-stacks --stack-name Produswest2ServiceStack \
  --profile prod | grep OutputValue"

# Get website URLs
printf "\nWebsite URLs:"
printf "\n  Beta CloudFront: $(aws cloudformation describe-stacks --stack-name WebsiteBetaus-west-2BucketStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`WebsiteURLOutput`].OutputValue' --output text)"
printf "\n  Prod CloudFront: $(aws cloudformation describe-stacks --stack-name WebsiteProdus-west-2BucketStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`WebsiteURLOutput`].OutputValue' --output text)"

# Get Domain Configuration information
printf "\nDomain Configuration (Beta only):"
printf "\n  Beta Domain: $(aws cloudformation describe-stacks --stack-name WebsiteBetaus-west-2Domainqandmedating-comStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`DomainName`].OutputValue' --output text)"
printf "\n  Name Servers: $(aws cloudformation describe-stacks --stack-name WebsiteBetaus-west-2Domainqandmedating-comStack \
  --profile beta --query 'Stacks[0].Outputs[?OutputKey==`NameServers`].OutputValue' --output text)"

# Clean up temporary files
rm -f ${CDK_OUTPUT_FILE} .cfn_outputs

# Namecheap DNS Setup Instructions
printf "\n\n=== IMPORTANT NEXT STEPS FOR DOMAIN MIGRATION ==="
printf "\n1. Log in to your Namecheap account"
printf "\n2. Go to Domain List and select qandmedating.com"
printf "\n3. Select 'Custom DNS' as the Nameservers type"
printf "\n4. Enter the AWS name servers shown above (separated by commas)"
printf "\n5. Save changes and wait for DNS propagation (can take up to 48 hours)"
printf "\n6. Once propagated, your site will be available at beta.qandmedating.com"
printf "\n======================================================\n"