exports.handler = async (event) => {
  const response = {
    statusCode: 200,
    body: `Hello from the ${process.env.STAGE_NAME} environment!\n`,
  };
  return response;
};
