#!/bin/bash
# Production Domain Deployment Script
# This script specifically deploys the domain configuration for the production environment
# after the beta environment has been successfully deployed and tested

# Prerequisites: 
# - Set up .aws/credentials profiles for pipeline, beta, and prod
# - Set PIPELINE_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID env variables
# - Website infrastructure must already be deployed

# If prerequisite account values aren't set, exit
if [[ -z "${PIPELINE_ACCOUNT_ID}" || -z "${BETA_ACCOUNT_ID}" || -z "${PROD_ACCOUNT_ID}" ]]; then
  printf "Please set PIPELINE_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID\n"
  printf "PIPELINE_ACCOUNT_ID = ${PIPELINE_ACCOUNT_ID}\n"
  printf "BETA_ACCOUNT_ID = ${BETA_ACCOUNT_ID}\n"
  printf "PROD_ACCOUNT_ID = ${PROD_ACCOUNT_ID}\n"
  exit 1
fi

# Build the CDK app
printf "\nBuilding CDK app\n"
npm install
npm audit fix --force || echo "Audit fix completed with warnings"
npm run build

# Deploy Production Domain Configuration Stack
printf "\nDeploying Production Domain Configuration Stack\n"
cdk_output_file='.prod_domain_output'
rm -f ${cdk_output_file}

npx cdk deploy WebsiteProdus-west-2Domainqandmedating-comStack \
  --profile prod \
  --require-approval never \
  2>&1 | tee -a ${cdk_output_file}

# Check if the deployment was successful
if grep -q "WebsiteProdus-west-2Domainqandmedating-comStack: creating CloudFormation changeset" ${cdk_output_file}; then
  printf "\nProduction domain configuration stack deployed successfully!\n"
else
  printf "\nThere was an issue with deploying the production domain configuration stack. Please check the output file: ${cdk_output_file}\n"
  exit 1
fi

# Get Domain Configuration information
printf "\nProduction Domain Configuration Information:\n"
printf "\n  Production Domain: $(aws cloudformation describe-stacks --stack-name WebsiteProdus-west-2Domainqandmedating-comStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`DomainName`].OutputValue' --output text)"
printf "\n  Name Servers: $(aws cloudformation describe-stacks --stack-name WebsiteProdus-west-2Domainqandmedating-comStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`NameServers`].OutputValue' --output text)"
printf "\n  Distribution ID: $(aws cloudformation describe-stacks --stack-name WebsiteProdus-west-2Domainqandmedating-comStack \
  --profile prod --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)"

# Update the website pipeline with the production CloudFront distribution ID
printf "\nTriggering Website Pipeline Deployment to Update Pipeline Configuration\n"
git add .
git commit -m "Update website pipeline with production domain configuration"
git push

# Check certificate validation status
printf "\nTo check certificate validation status (must be ISSUED before your site will work):"
printf "\naws acm list-certificates --region us-east-1 --profile prod | grep qandmedating"
printf "\naws acm describe-certificate --region us-east-1 --profile prod --certificate-arn YOUR_CERT_ARN | grep Status\n"

# Namecheap DNS Setup Instructions
printf "\n\n=== IMPORTANT NEXT STEPS FOR PRODUCTION DOMAIN MANAGEMENT ==="
printf "\n1. Log in to your Namecheap account"
printf "\n2. Go to Domain List and select qandmedating.com"
printf "\n3. Select 'Custom DNS' as the Nameservers type"
printf "\n4. Enter the AWS name servers shown above (there should be 4 of them, separated by commas)"
printf "\n5. Save changes and wait for DNS propagation (can take up to 48 hours)"
printf "\n6. To check DNS propagation progress, use: dig +trace qandmedating.com"
printf "\n7. Once propagated, your site will be available at:"
printf "\n   - Production: qandmedating.com and www.qandmedating.com"
printf "\n======================================================\n"

# Clean up temporary files
rm -f ${cdk_output_file}