/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Request, Server } from 'hapi';

import { Logger, LoggerFactory } from '../logging';
import { HttpConfig } from './http_config';
import { createServer, getListenerOptions, getServerOptions } from './http_tools';
import { adoptToHapiAuthFormat, AuthenticationHandler } from './lifecycle/auth';
import { adoptToHapiOnPostAuthFormat, OnPostAuthHandler } from './lifecycle/on_post_auth';
import { adoptToHapiOnPreAuthFormat, OnPreAuthHandler } from './lifecycle/on_pre_auth';

import { ResponseHeaders, IRouter } from './router';
import {
  SessionStorageCookieOptions,
  createCookieSessionStorageFactory,
} from './cookie_session_storage';
import { AuthStateStorage, GetAuthState, IsAuthenticated } from './auth_state_storage';
import { AuthHeadersStorage, GetAuthHeaders } from './auth_headers_storage';
import { BasePath } from './base_path_service';
import { HttpServiceSetup } from './types';

/** @internal */
export interface HttpServerSetup {
  server: Server;
  /**
   * Add all the routes registered with `router` to HTTP server request listeners.
   * @param router {@link IRouter} - a router with registered route handlers.
   */
  registerRouter: (router: IRouter) => void;
  basePath: HttpServiceSetup['basePath'];
  createCookieSessionStorageFactory: HttpServiceSetup['createCookieSessionStorageFactory'];
  registerAuth: HttpServiceSetup['registerAuth'];
  registerOnPreAuth: HttpServiceSetup['registerOnPreAuth'];
  registerOnPostAuth: HttpServiceSetup['registerOnPostAuth'];
  isTlsEnabled: HttpServiceSetup['isTlsEnabled'];
  auth: {
    get: GetAuthState;
    isAuthenticated: IsAuthenticated;
    getAuthHeaders: GetAuthHeaders;
  };
}

export class HttpServer {
  private server?: Server;
  private config?: HttpConfig;
  private registeredRouters = new Set<IRouter>();
  private authRegistered = false;
  private cookieSessionStorageCreated = false;

  private readonly log: Logger;
  private readonly authState: AuthStateStorage;
  private readonly authRequestHeaders: AuthHeadersStorage;
  private readonly authResponseHeaders: AuthHeadersStorage;

  constructor(private readonly logger: LoggerFactory, private readonly name: string) {
    this.authState = new AuthStateStorage(() => this.authRegistered);
    this.authRequestHeaders = new AuthHeadersStorage();
    this.authResponseHeaders = new AuthHeadersStorage();
    this.log = logger.get('http', 'server', name);
  }

  public isListening() {
    return this.server !== undefined && this.server.listener.listening;
  }

  private registerRouter(router: IRouter) {
    if (this.isListening()) {
      throw new Error('Routers can be registered only when HTTP server is stopped.');
    }

    this.registeredRouters.add(router);
  }

  public setup(config: HttpConfig): HttpServerSetup {
    const serverOptions = getServerOptions(config);
    const listenerOptions = getListenerOptions(config);
    this.server = createServer(serverOptions, listenerOptions);
    this.config = config;

    const basePathService = new BasePath(config.basePath);
    this.setupBasePathRewrite(config, basePathService);

    return {
      registerRouter: this.registerRouter.bind(this),
      registerOnPreAuth: this.registerOnPreAuth.bind(this),
      registerOnPostAuth: this.registerOnPostAuth.bind(this),
      createCookieSessionStorageFactory: <T>(cookieOptions: SessionStorageCookieOptions<T>) =>
        this.createCookieSessionStorageFactory(cookieOptions, config.basePath),
      registerAuth: this.registerAuth.bind(this),
      basePath: basePathService,
      auth: {
        get: this.authState.get,
        isAuthenticated: this.authState.isAuthenticated,
        getAuthHeaders: this.authRequestHeaders.get,
      },
      isTlsEnabled: config.ssl.enabled,
      // Return server instance with the connection options so that we can properly
      // bridge core and the "legacy" Kibana internally. Once this bridge isn't
      // needed anymore we shouldn't return the instance from this method.
      server: this.server,
    };
  }

  public async start() {
    if (this.server === undefined) {
      throw new Error('Http server is not setup up yet');
    }
    this.log.debug('starting http server');

    for (const router of this.registeredRouters) {
      for (const route of router.getRoutes()) {
        this.log.debug(`registering route handler for [${route.path}]`);
        const { authRequired = true, tags } = route.options;
        this.server.route({
          handler: route.handler,
          method: route.method,
          path: route.path,
          options: {
            auth: authRequired ? undefined : false,
            tags: tags ? Array.from(tags) : undefined,
          },
        });
      }
    }

    await this.server.start();
    const serverPath =
      this.config && this.config.rewriteBasePath && this.config.basePath !== undefined
        ? this.config.basePath
        : '';

    this.log.info(`http server running at ${this.server.info.uri}${serverPath}`);
  }

  public async stop() {
    if (this.server === undefined) {
      return;
    }

    this.log.debug('stopping http server');
    await this.server.stop();
    this.server = undefined;
  }

  private setupBasePathRewrite(config: HttpConfig, basePathService: BasePath) {
    if (config.basePath === undefined || !config.rewriteBasePath) {
      return;
    }

    this.registerOnPreAuth((request, response, toolkit) => {
      const oldUrl = request.url.href!;
      const newURL = basePathService.remove(oldUrl);
      const shouldRedirect = newURL !== oldUrl;
      if (shouldRedirect) {
        return toolkit.rewriteUrl(newURL);
      }
      return response.notFound();
    });
  }

  private registerOnPostAuth(fn: OnPostAuthHandler) {
    if (this.server === undefined) {
      throw new Error('Server is not created yet');
    }

    this.server.ext('onPostAuth', adoptToHapiOnPostAuthFormat(fn, this.log));
  }

  private registerOnPreAuth(fn: OnPreAuthHandler) {
    if (this.server === undefined) {
      throw new Error('Server is not created yet');
    }

    this.server.ext('onRequest', adoptToHapiOnPreAuthFormat(fn, this.log));
  }

  private async createCookieSessionStorageFactory<T>(
    cookieOptions: SessionStorageCookieOptions<T>,
    basePath?: string
  ) {
    if (this.server === undefined) {
      throw new Error('Server is not created yet');
    }
    if (this.cookieSessionStorageCreated) {
      throw new Error('A cookieSessionStorageFactory was already created');
    }
    this.cookieSessionStorageCreated = true;
    const sessionStorageFactory = await createCookieSessionStorageFactory<T>(
      this.logger.get('http', 'server', this.name, 'cookie-session-storage'),
      this.server,
      cookieOptions,
      basePath
    );
    return sessionStorageFactory;
  }

  private registerAuth<T>(fn: AuthenticationHandler) {
    if (this.server === undefined) {
      throw new Error('Server is not created yet');
    }
    if (this.authRegistered) {
      throw new Error('Auth interceptor was already registered');
    }
    this.authRegistered = true;

    this.server.auth.scheme('login', () => ({
      authenticate: adoptToHapiAuthFormat(
        fn,
        this.log,
        (req, { state, requestHeaders, responseHeaders }) => {
          this.authState.set(req, state);

          if (responseHeaders) {
            this.authResponseHeaders.set(req, responseHeaders);
          }

          if (requestHeaders) {
            this.authRequestHeaders.set(req, requestHeaders);
            // we mutate headers only for the backward compatibility with the legacy platform.
            // where some plugin read directly from headers to identify whether a user is authenticated.
            Object.assign(req.headers, requestHeaders);
          }
        }
      ),
    }));
    this.server.auth.strategy('session', 'login');

    // The default means that the `session` strategy that is based on `login` schema defined above will be
    // automatically assigned to all routes that don't contain an auth config.
    // should be applied for all routes if they don't specify auth strategy in route declaration
    // https://github.com/hapijs/hapi/blob/master/API.md#-serverauthdefaultoptions
    this.server.auth.default('session');

    this.server.ext('onPreResponse', (request, t) => {
      const authResponseHeaders = this.authResponseHeaders.get(request);
      this.extendResponseWithHeaders(request, authResponseHeaders);
      return t.continue;
    });
  }

  private extendResponseWithHeaders(request: Request, headers?: ResponseHeaders) {
    const response = request.response;
    if (!headers || !response) return;

    if (response instanceof Error) {
      this.findHeadersIntersection(response.output.headers, headers);
      // hapi wraps all error response in Boom object internally
      response.output.headers = {
        ...response.output.headers,
        ...(headers as any), // hapi types don't specify string[] as valid value
      };
    } else {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        this.findHeadersIntersection(response.headers, headers);
        response.header(headerName, headerValue as any); // hapi types don't specify string[] as valid value
      }
    }
  }

  // NOTE: responseHeaders contains not a full list of response headers, but only explicitly set on a response object.
  // any headers added by hapi internally, like `content-type`, `content-length`, etc. do not present here.
  private findHeadersIntersection(responseHeaders: ResponseHeaders, headers: ResponseHeaders) {
    Object.keys(headers).forEach(headerName => {
      if (responseHeaders[headerName] !== undefined) {
        this.log.warn(`Server rewrites a response header [${headerName}].`);
      }
    });
  }
}
