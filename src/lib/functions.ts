import { functions, type Models } from "./appwrite";

type HttpMethod = Parameters<typeof functions.createExecution>[4];

export type Execution = Models.Execution;

export async function executeFunction(
    functionId: string,
    body?: string,
    async?: boolean,
    path?: string,
    method?: HttpMethod,
    headers?: Record<string, string>
): Promise<Execution> {
    return await functions.createExecution(
        functionId,
        body,
        async,
        path,
        method,
        headers
    );
}

export async function executeFunctionJson<T = unknown>(
    functionId: string,
    data: unknown,
    options?: {
        async?: boolean;
        path?: string;
        method?: HttpMethod;
        headers?: Record<string, string>;
    }
): Promise<{ execution: Execution; response: T | null }> {
    const execution = await functions.createExecution(
        functionId,
        JSON.stringify(data),
        options?.async,
        options?.path,
        options?.method,
        {
            "Content-Type": "application/json",
            ...options?.headers,
        }
    );

    let response: T | null = null;
    if (execution.responseBody) {
        try {
            response = JSON.parse(execution.responseBody) as T;
        } catch {
            // Response is not JSON
        }
    }

    return { execution, response };
}

export async function getExecution(
    functionId: string,
    executionId: string
): Promise<Execution> {
    return await functions.getExecution(functionId, executionId);
}

export async function listExecutions(
    functionId: string,
    queries?: string[]
): Promise<Models.ExecutionList> {
    return await functions.listExecutions(functionId, queries);
}
