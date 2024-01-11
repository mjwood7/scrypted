import { HttpFetchOptions, HttpFetchResponseType, checkStatus, fetcher, getFetchMethod, setDefaultHttpFetchAccept } from '../../../server/src/fetch';

export interface AuthFetchCredentialState {
    username: string;
    password: string;
    [key: string]: any;
}

export interface AuthFetchOptions {
    credential?: AuthFetchCredentialState;
}

async function getAuth(options: AuthFetchOptions, url: string | URL, method: string) {
    if (!options.credential)
        return;

    const { BASIC, DIGEST, parseWWWAuthenticateHeader } = await import('http-auth-utils');

    const { digest, basic } = options.credential as AuthFetchCredentialState & {
        count?: number;
        digest?: ReturnType<typeof parseWWWAuthenticateHeader<typeof DIGEST>>;
        basic?: ReturnType<typeof parseWWWAuthenticateHeader<typeof BASIC>>;
    };

    if (digest) {
        options.credential.count ||= 0;
        ++options.credential.count;
        const nc = ('00000000' + options.credential.count).slice(-8);
        const cnonce = [...Array(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
        const uri = new URL(url).pathname;

        const { DIGEST, buildAuthorizationHeader } = await import('http-auth-utils');

        const response = DIGEST.computeHash({
            username: options.credential.username,
            password: options.credential.password,
            method,
            uri,
            nc,
            cnonce,
            algorithm: 'MD5',
            qop: digest.data.qop!,
            ...digest.data,
        });

        const header = buildAuthorizationHeader(DIGEST, {
            username: options.credential.username,
            uri,
            nc,
            cnonce,
            algorithm: digest.data.algorithm!,
            qop: digest.data.qop!,
            response,
            ...digest.data,
        });

        return header;
    }
    else if (basic) {
        const { BASIC, buildAuthorizationHeader } = await import('http-auth-utils');

        const header = buildAuthorizationHeader(BASIC, {
            username: options.credential.username,
            password: options.credential.password,
        });

        return header;
    }
}

export function createAuthFetch<B, M>(
    h: fetcher<B, M>,
    parser: (body: M, responseType: HttpFetchResponseType) => Promise<any>
) {
    const authHttpFetch = async <T extends HttpFetchOptions<HttpFetchResponseType, B>>(options: T & AuthFetchOptions): ReturnType<typeof h<T>> => {
        const method = getFetchMethod(options);
        const headers = new Headers(options.headers);
        options.headers = headers;
        setDefaultHttpFetchAccept(headers, options.responseType);

        const initialHeader = await getAuth(options, options.url, method);
        // try to provide an authorization if a session exists, but don't override Authorization if provided already.
        // 401 will trigger a proper auth.
        if (initialHeader && !headers.has('Authorization'))
            headers.set('Authorization', initialHeader);

        const initialResponse = await h({
            ...options,
            ignoreStatusCode: true,
            responseType: 'readable',
        });

        if (initialResponse.statusCode !== 401 || !options.credential) {
            if (!options?.ignoreStatusCode)
                checkStatus(initialResponse.statusCode);
            return {
                ...initialResponse,
                body: await parser(initialResponse.body, options.responseType),
            };
        }

        let authenticateHeaders: string | string[] = initialResponse.headers.get('www-authenticate');
        if (!authenticateHeaders)
            throw new Error('Did not find WWW-Authenticate header.');


        if (typeof authenticateHeaders === 'string')
            authenticateHeaders = [authenticateHeaders];

        const { BASIC, DIGEST, parseWWWAuthenticateHeader } = await import('http-auth-utils');
        const parsedHeaders = authenticateHeaders.map(h => parseWWWAuthenticateHeader(h));

        const digest = parsedHeaders.find(p => p.type === 'Digest') as ReturnType<typeof parseWWWAuthenticateHeader<typeof DIGEST>>;
        const basic = parsedHeaders.find(p => p.type === 'Basic') as ReturnType<typeof parseWWWAuthenticateHeader<typeof BASIC>>;

        options.credential.digest = digest;
        options.credential.basic = basic;

        if (!digest && !basic)
            throw new Error(`Unknown WWW-Authenticate type: ${parsedHeaders[0]?.type}`);

        const header = await getAuth(options, options.url, method);
        if (header)
            headers.set('Authorization', header);

        return h(options);
    }

    return authHttpFetch;
}