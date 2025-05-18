import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RemovalPolicy, Duration } from 'aws-cdk-lib';

export interface ContactFormStackProps extends cdk.StackProps {
  readonly stageName: string;
}

export class ContactFormStack extends cdk.Stack {
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: ContactFormStackProps) {
    super(scope, id, props);

    // Define DynamoDB table for contact form submissions
    // Define sort key at table creation time instead of using addSortKey
    const contactTable = new dynamodb.Table(this, 'ContactFormTable', {
      tableName: `ContactForm-${props.stageName}`,
      partitionKey: {
        name: 'email',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.stageName === 'Prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      pointInTimeRecovery: props.stageName === 'Prod',
    });

    // Add GSI for querying by date
    contactTable.addGlobalSecondaryIndex({
      indexName: 'DateIndex',
      partitionKey: {
        name: 'date',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Add GSI for querying by subject (to easily filter waitlist signups)
    contactTable.addGlobalSecondaryIndex({
      indexName: 'SubjectIndex',
      partitionKey: {
        name: 'subject',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Create Lambda for processing contact form submissions
    const contactFormLambda = new lambda.Function(this, 'ContactFormFunction', {
      functionName: `ContactForm-${props.stageName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const AWS = require('aws-sdk');
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const tableName = process.env.TABLE_NAME;
const maxItems = parseInt(process.env.MAX_ITEMS) || 10000;

exports.handler = async (event) => {
  try {
    // Set CORS headers for all responses
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGINS,
      'Access-Control-Allow-Credentials': true,
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    };
    
    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'CORS preflight response successful' })
      };
    }
    
    // Parse request body
    const body = JSON.parse(event.body);
    
    // Validate required fields - waitlist only requires email
    if (!body.email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          message: 'Missing required field: email. Please provide an email address.'
        })
      };
    }

    // For contact form, require additional fields
    if (body.subject !== 'Waitlist Registration' && (!body.name || !body.subject || !body.message)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          message: 'Missing required fields. Please provide name, email, subject and message.'
        })
      };
    }

    // Check if table has reached size limit
    const countParams = {
      TableName: tableName,
      Select: 'COUNT'
    };
    
    const countResult = await dynamoDB.scan(countParams).promise();
    
    if (countResult.Count >= maxItems) {
      console.error('DynamoDB table size limit reached');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          message: 'Internal server error'
        })
      };
    }
    
    // Generate timestamp and date
    const now = new Date();
    const timestamp = now.toISOString();
    const date = timestamp.split('T')[0]; // YYYY-MM-DD format
    
    // Prepare item for DynamoDB
    const item = {
      email: body.email,
      timestamp: timestamp,
      date: date,
      name: body.name,
      subject: body.subject,
      message: body.message,
      ipAddress: event.requestContext?.identity?.sourceIp || 'unknown',
    };
    
    // Write to DynamoDB
    await dynamoDB.put({
      TableName: tableName,
      Item: item
    }).promise();
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: body.subject === 'Waitlist Registration' 
          ? 'Waitlist registration received successfully' 
          : 'Contact form submission received successfully',
        id: timestamp
      })
    };
  } catch (error) {
    console.error('Error processing submission:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGINS,
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      },
      body: JSON.stringify({
        message: 'Error processing submission'
      })
    };
  }
};
      `),
      environment: {
        TABLE_NAME: contactTable.tableName,
        MAX_ITEMS: '10000', // Table size limit
        ALLOWED_ORIGINS:
          props.stageName === 'Prod'
            ? 'https://qandmedating.com,https://www.qandmedating.com'
            : 'https://beta.qandmedating.com,http://localhost:3000',
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    // Grant Lambda permissions to write to DynamoDB
    contactTable.grantReadWriteData(contactFormLambda);

    // Allow Lambda to scan table for count
    contactFormLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [contactTable.tableArn],
      }),
    );

    // Create API Gateway REST API with CORS properly configured
    const api = new apigateway.RestApi(this, 'ContactFormApi', {
      restApiName: `ContactForm-API-${props.stageName}`,
      description: `API for contact form submissions - ${props.stageName}`,
      defaultCorsPreflightOptions: {
        allowOrigins:
          props.stageName === 'Prod'
            ? ['https://qandmedating.com', 'https://www.qandmedating.com']
            : ['https://beta.qandmedating.com', 'http://localhost:3000'],
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
        allowCredentials: true,
        maxAge: Duration.days(1),
      },
    });

    // Create API resource and method
    const contactResource = api.root.addResource('contact');

    // Define the Lambda integration
    const lambdaIntegration = new apigateway.LambdaIntegration(contactFormLambda, {
      proxy: true,
      // Ensure content type is set correctly
      requestTemplates: {
        'application/json': '{ "statusCode": 200 }',
      },
      // Map response headers correctly for CORS
      integrationResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin':
              props.stageName === 'Prod' ? "'https://qandmedating.com'" : "'https://beta.qandmedating.com'",
            'method.response.header.Access-Control-Allow-Headers':
              "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
            'method.response.header.Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
            'method.response.header.Access-Control-Allow-Credentials': "'true'",
          },
        },
        {
          // For handling errors
          selectionPattern: '.*',
          statusCode: '400',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin':
              props.stageName === 'Prod' ? "'https://qandmedating.com'" : "'https://beta.qandmedating.com'",
            'method.response.header.Access-Control-Allow-Headers':
              "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
            'method.response.header.Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
            'method.response.header.Access-Control-Allow-Credentials': "'true'",
          },
        },
      ],
    });

    // POST method for submitting contact forms with CORS headers in response
    contactResource.addMethod('POST', lambdaIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
            'method.response.header.Access-Control-Allow-Credentials': true,
          },
        },
        {
          statusCode: '400',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
            'method.response.header.Access-Control-Allow-Credentials': true,
          },
        },
      ],
    });

    // Output the API endpoint URL
    this.apiEndpoint = api.url;

    new cdk.CfnOutput(this, 'ApiEndpointOutput', {
      value: api.url,
      description: 'URL of the Contact Form API endpoint',
      exportName: `${props.stageName}-ContactFormApiEndpoint`,
    });

    // Add specific deployed endpoint URLs for easy reference
    new cdk.CfnOutput(this, 'ApiContactEndpointOutput', {
      value: `${api.url}contact`,
      description: 'Complete URL for the contact resource endpoint',
      exportName: `${props.stageName}-ContactFormSpecificEndpoint`,
    });

    new cdk.CfnOutput(this, 'ContactFormTableNameOutput', {
      value: contactTable.tableName,
      description: 'Name of the DynamoDB table storing contact form submissions',
      exportName: `${props.stageName}-ContactFormTableName`,
    });
  }
}
