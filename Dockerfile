FROM public.ecr.aws/lambda/nodejs:20-arm64

COPY dist/ ${LAMBDA_TASK_ROOT}/dist/
COPY package.json ${LAMBDA_TASK_ROOT}/
COPY node_modules/ ${LAMBDA_TASK_ROOT}/node_modules/

CMD ["dist/http.handler"]
