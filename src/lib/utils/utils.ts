import { SERVICE_STACK, VPC_STACK, DEVICE_FARM_STACK, DEPLOYMENT_BUCKET_STACK } from './constants';

export function createServiceStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${SERVICE_STACK}`;
}

export function createVpcStackName(stage: string, region: string, account: string): string {
  return `${account}${stage}${region.replace(/-/g, '')}${VPC_STACK}`;
}

export function createDeviceFarmStackName(stage: string, region: string, account: string): string {
  return `${account}${stage}${region.replace(/-/g, '')}${DEVICE_FARM_STACK}`;
}

export function createDeploymentBucketStackName(stage: string, region: string, account: string): string {
  return `${account}${stage}${region.replace(/-/g, '')}${DEPLOYMENT_BUCKET_STACK}`;
}

export function createWebsiteBucketStackName(stage: string, region: string, prefix: string): string {
  return `${prefix}${stage}${region}BucketStack`;
}
