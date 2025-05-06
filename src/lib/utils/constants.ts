// app constants

export const SERVICE_STACK = 'ServiceStack';
export const VPC_STACK = 'VpcStack';
export const DEVICE_FARM_STACK = 'DeviceFarmStack';
export const DEPLOYMENT_BUCKET_STACK = 'DeploymentBucketStack';

export const FRONT_END = 'FrontEnd';
export const BACK_END = 'BackEnd';

// Pipeline Constants
export const SECRET_NAME = 'github-token-plaintext';
export const BackendPipelineStackName = 'PipelineDeploymentStack';
export const FrontendPipelineStackName = 'FrontEndPipelineDeploymentStack';
export const TEMPLATE_ENDING = '.template.json';

// website additions
export const WebsitePipelineStackName = 'WebsitePipelineStack';
export const WEBSITE = 'Website';
export const WEBSITE_BUCKET_STACK = 'WebsiteBucketStack';
export const DOMAIN_NAME = 'qandmedating.com';

// BETA CERT
export const SHARED_CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:${AWS::AccountId}:certificate/53943950-4479-4e30-a7fb-2cbf2ecb766f';
