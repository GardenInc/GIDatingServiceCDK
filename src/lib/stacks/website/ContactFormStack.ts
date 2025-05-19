import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
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

    // Create Lambda for processing contact form submissions without bundling
    // This version doesn't require Docker and simply packages the code as-is
    const contactFormLambda = new lambda.Function(this, 'ContactFormFunction', {
      functionName: `ContactForm-${props.stageName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '/lambda/contactFormLambda')),
      environment: {
        TABLE_NAME: contactTable.tableName,
        MAX_ITEMS: '10000', // Table size limit
        ALLOWED_ORIGINS:
          props.stageName === 'Prod'
            ? 'https://qandmedating.com,https://www.qandmedating.com'
            : 'https://beta.qandmedating.com,http://localhost:3000',
        NODE_ENV: props.stageName === 'Prod' ? 'production' : 'development',
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE, // Enable X-Ray tracing for better debugging
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

    // POST method for submitting contact forms
    contactResource.addMethod('POST', new apigateway.LambdaIntegration(contactFormLambda));

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
