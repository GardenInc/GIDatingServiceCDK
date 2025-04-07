#!/bin/bash
# Website Pipeline Deployment Script
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
printf "\nDeploying roles to BETA and Prod\n"

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

# Clean up the cdk.out directory before starting
rm -rf cdk.out/website-pipeline
mkdir -p cdk.out/website-pipeline

# Deploy Website Pipeline Stack
printf "\nDeploying Website Pipeline Stack\n"
CDK_OUTPUT_FILE='.website_cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .website_cfn_outputs
npx cdk deploy WebsitePipelineStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  --output cdk.out/website-pipeline \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .website_cfn_outputs
WEBSITE_KEY_ARN=$(awk -F " " '/WebsiteArtifactBucketEncryptionKeyArn/ { print $3 }' .website_cfn_outputs)

# Check that WEBSITE_KEY_ARN is set after the CDK deployment
if [[ -z "${WEBSITE_KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the Website CDK Pipeline deployment"
  exit 1
fi

# Update the CloudFormation roles with the Website Key ARN
printf "\nUpdating roles with Website pipeline key in BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta WebsiteKeyArn=${WEBSITE_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta WebsiteKeyArn=${WEBSITE_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod WebsiteKeyArn=${WEBSITE_KEY_ARN}

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod WebsiteKeyArn=${WEBSITE_KEY_ARN}

# Prompt for commit and push
printf "\nDo you want to commit and push changes to trigger the pipeline? (y/n): "
read COMMIT_RESPONSE

if [[ "$COMMIT_RESPONSE" == "y" || "$COMMIT_RESPONSE" == "Y" ]]; then
  printf "\nCommitting code to repository\n"
  git add .
  git commit -m "Automated Website Pipeline Deployment"
  git push
  printf "\nCode committed and pushed. Pipeline should start shortly.\n"
else
  printf "\nSkipping commit. You can manually commit and push when ready.\n"
fi

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
rm -f ${CDK_OUTPUT_FILE} .website_cfn_outputs

# Namecheap DNS Setup Instructions
printf "\n\n=== IMPORTANT NEXT STEPS FOR DOMAIN MANAGEMENT ==="
printf "\n1. Log in to your Namecheap account"
printf "\n2. Go to Domain List and select qandmedating.com"
printf "\n3. Select 'Custom DNS' as the Nameservers type"
printf "\n4. Enter the AWS name servers shown above (there should be 4 of them, separated by commas)"
printf "\n5. Save changes and wait for DNS propagation (can take up to 48 hours)"
printf "\n6. To check DNS propagation progress, use: dig +trace qandmedating.com"
printf "\n7. Once propagated, your site will be available at:"
printf "\n   - Beta: beta.qandmedating.com"
printf "\n   - Prod: qandmedating.com (after prod deployment)"
printf "\n======================================================\n"

# Check certificate validation status
printf "\nTo check certificate validation status (must be ISSUED before your site will work):"
printf "\naws acm list-certificates --region us-east-1 --profile beta | grep qandmedating"
printf "\naws acm describe-certificate --region us-east-1 --profile beta --certificate-arn YOUR_CERT_ARN | grep Status\n"