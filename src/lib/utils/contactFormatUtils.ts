import { STAGES } from './config';

// Constants for contact form stack
export const CONTACT_FORM_STACK = 'ContactFormStack';

/**
 * Creates a contact form stack name based on stage and region
 */
export function createContactFormStackName(stage: string, region: string): string {
  return `${stage}${region.replace(/-/g, '')}${CONTACT_FORM_STACK}`;
}

/**
 * Get the API endpoint URL for the contact form
 * To be used in frontend code to make API calls
 */
export function getContactFormApiEndpoint(stage: string): string {
  if (stage === STAGES.BETA) {
    return 'https://api-endpoint-for-beta.execute-api.us-west-2.amazonaws.com/prod/contact';
  } else {
    return 'https://api-endpoint-for-prod.execute-api.us-west-2.amazonaws.com/prod/contact';
  }
}
