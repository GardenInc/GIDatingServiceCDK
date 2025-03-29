#!/bin/bash
# Set the region explicitly to us-west-2 where Device Farm exists
REGION="us-west-2"

# Get the function name from stack outputs
FUNCTION_NAME=$(aws cloudformation describe-stacks \
  --stack-name FrontEndBetauswest2DeviceFarmStack \
  --query "Stacks[0].Outputs[?OutputKey=='TriggerTestFunctionName'].OutputValue" \
  --profile beta \
  --region $REGION \
  --output text)

echo "Starting Device Farm test using function: $FUNCTION_NAME"

# Invoke the function in the correct region
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  --profile beta \
  --region $REGION \
  response.json

# Print the complete response for debugging
echo "Full response:"
cat response.json

# Check for function errors
if grep -q "FunctionError" response.json; then
  echo "ERROR: Lambda function encountered an error during execution."
  echo "Checking CloudWatch logs for more details..."
  
  # Get the most recent log events
  LOG_GROUP_NAME="/aws/lambda/$FUNCTION_NAME"
  echo "Log group: $LOG_GROUP_NAME"
  
  # Get the latest log stream
  LATEST_LOG_STREAM=$(aws logs describe-log-streams \
    --log-group-name $LOG_GROUP_NAME \
    --order-by LastEventTime \
    --descending \
    --profile beta \
    --region $REGION \
    --query "logStreams[0].logStreamName" \
    --output text)
  
  echo "Latest log stream: $LATEST_LOG_STREAM"
  
  # Get the latest logs
  aws logs get-log-events \
    --log-group-name $LOG_GROUP_NAME \
    --log-stream-name "$LATEST_LOG_STREAM" \
    --profile beta \
    --region $REGION \
    --query "events[*].message" \
    --output text
  
  echo "Test failed. Please check the logs above for more details."
  exit 1
fi

# Parse the response directly using jq
PAYLOAD=$(cat response.json | jq '.')
echo "Parsed payload: $PAYLOAD"

# Extract status code and run ARN from the payload
STATUS_CODE=$(echo $PAYLOAD | jq -r '.statusCode')
RUN_ARN=$(echo $PAYLOAD | jq -r '.runArn')
MESSAGE=$(echo $PAYLOAD | jq -r '.message')
MONITORING_RULE=$(echo $PAYLOAD | jq -r '.monitoringRule')

if [ -z "$STATUS_CODE" ] || [ "$STATUS_CODE" != "200" ]; then
  echo "Failed to start test: $PAYLOAD"
  exit 1
fi

echo "Test started successfully!"
echo "Run ARN: $RUN_ARN"
echo "Monitoring Rule: $MONITORING_RULE"
echo "Test is now running in Device Farm. Results will be saved to S3 when complete."

# Optionally: Monitor the status (this will run in a loop until completion)
echo "Do you want to monitor the test status? (y/n)"
read MONITOR

if [ "$MONITOR" = "y" ]; then
  echo "Monitoring test status every 60 seconds. Press Ctrl+C to stop."
  while true; do
    aws lambda invoke \
      --function-name $(aws cloudformation describe-stacks \
        --stack-name FrontEndBetauswest2DeviceFarmStack \
        --query "Stacks[0].Outputs[?OutputKey=='CheckStatusFunctionName'].OutputValue" \
        --profile beta \
        --region $REGION \
        --output text) \
      --payload "{\"runArn\":\"$RUN_ARN\"}" \
      --cli-binary-format raw-in-base64-out \
      --profile beta \
      --region $REGION \
      status.json
    
    STATUS_RESULT=$(cat status.json | jq '.')
    TEST_STATUS=$(echo $STATUS_RESULT | jq -r '.status')
    
    echo "$(date): Test status: $TEST_STATUS"
    
    if [[ "$TEST_STATUS" == "COMPLETED" || "$TEST_STATUS" == "STOPPING" || "$TEST_STATUS" == "STOPPED" ]]; then
      echo "Test completed with result: $(echo $STATUS_RESULT | jq -r '.result')"
      echo "Results saved to: $(echo $STATUS_RESULT | jq -r '.resultsLocation')"
      break
    fi
    
    sleep 60
  done
fi