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
    // Parse request body
    const body = JSON.parse(event.body);
    
    // Validate required fields
    if (!body.name || !body.email || !body.subject || !body.message) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
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
      ipAddress: event.requestContext?.identity?.sourceIp || 'unknown'
    };
    
    // Write to DynamoDB
    await dynamoDB.put({
      TableName: tableName,
      Item: item
    }).promise();
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        message: 'Contact form submission received successfully',
        id: timestamp
      })
    };
  } catch (error) {
    console.error('Error processing contact form submission:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        message: 'Error processing contact form submission'
      })
    };
  }
};
      `),
      environment: {
        TABLE_NAME: contactTable.tableName,
        MAX_ITEMS: '10000', // Table size limit
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

    // Create API Gateway REST API
    const api = new apigateway.RestApi(this, 'ContactFormApi', {
      restApiName: `ContactForm-API-${props.stageName}`,
      description: `API for contact form submissions - ${props.stageName}`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
    });

    // Create API resource and method
    const contactResource = api.root.addResource('contact');

    // POST method for submitting contact forms
    contactResource.addMethod('POST', new apigateway.LambdaIntegration(contactFormLambda));

    // Output the API endpoint URL
    this.apiEndpoint = api.url;

    new cdk.CfnOutput(this, 'ApiEndpointOutput', {
      value: api.url,
      description: 'URL of the Contact Form API endpoint',
      exportName: `${props.stageName}-ContactFormApiEndpoint`,
    });

    new cdk.CfnOutput(this, 'ContactFormTableNameOutput', {
      value: contactTable.tableName,
      description: 'Name of the DynamoDB table storing contact form submissions',
      exportName: `${props.stageName}-ContactFormTableName`,
    });

    // Add CloudWatch alarms and metrics (optional in the future)
  }
}
