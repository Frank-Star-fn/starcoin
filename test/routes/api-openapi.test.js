const express = require('express');
const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const spec = require('../../docs/openapi.json');
const createRoutes = require('../../src/routes');
const config = require('../../src/config');
const { createMockStarCoin, createMockP2P, newFreshChain } = require('../helpers');

function routerFor(chain = newFreshChain()) {
    return createRoutes(chain, createMockP2P(), () => {}, 3000);
}

function appFor(router) {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    return app;
}

function registeredOperations(router, prefix = '') {
    const operations = [];
    for (const layer of router.stack) {
        if (layer.route) {
            const path = (prefix + layer.route.path).replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
            for (const method of Object.keys(layer.route.methods)) operations.push(`${method.toUpperCase()} ${path}`);
        } else if (layer.handle.stack) {
            // Express 4 encodes static nested mounts (currently /wallet/hd) in its layer regexp.
            const mount = layer.regexp.fast_slash ? '' : layer.regexp.source.slice(1).split('\\/?')[0].replace(/\\\//g, '/');
            operations.push(...registeredOperations(layer.handle, prefix + mount));
        }
    }
    return operations;
}

function resolveRef(value) {
    return value.$ref ? value.$ref.slice(2).split('/').reduce((node, key) => node[key], spec) : value;
}

describe('OpenAPI document', () => {
    it('validates the OpenAPI schema and every internal reference', async () => {
        const validated = await SwaggerParser.validate(structuredClone(spec), { resolve: { external: false } });
        expect(validated.openapi).toBe('3.0.3');
        expect(validated.servers[0].url).toBe('/api');
    });

    it('covers every registered HTTP operation, including nested HD routes, without inactive endpoints', () => {
        const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
            Object.keys(item).map(method => `${method.toUpperCase()} ${path}`));
        expect(documented.sort()).toEqual(registeredOperations(routerFor()).sort());
        expect(spec.paths['/token/airdrop']).toBeUndefined();
    });

    it('uses unique operation IDs and defines every required path parameter', () => {
        const ids = new Set();
        for (const [path, item] of Object.entries(spec.paths)) {
            for (const operation of Object.values(item)) {
                expect(ids.has(operation.operationId)).toBe(false);
                ids.add(operation.operationId);
                for (const match of path.matchAll(/\{([^}]+)\}/g)) {
                    const parameter = (operation.parameters || []).map(resolveRef).find(p => p.name === match[1]);
                    expect(parameter?.in).toBe('path');
                    expect(parameter?.required).toBe(true);
                }
            }
        }
    });

    it('serves the static JSON through the actual API router without changing chain state', async () => {
        const chain = createMockStarCoin();
        const before = JSON.stringify({ chain: chain.chain, pool: chain.pendingTransactions });
        const response = await request(appFor(routerFor(chain))).get('/api/openapi.json');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(spec);
        expect(JSON.stringify({ chain: chain.chain, pool: chain.pendingTransactions })).toBe(before);
    });

    it('documents and observes the global rate limit on the document endpoint', async () => {
        const previous = config.RATE_LIMIT_GLOBAL_MAX;
        let app;
        try {
            config.RATE_LIMIT_GLOBAL_MAX = 1;
            app = appFor(routerFor());
        } finally { config.RATE_LIMIT_GLOBAL_MAX = previous; }
        await request(app).get('/api/openapi.json').expect(200);
        const response = await request(app).get('/api/openapi.json');
        expect(response.status).toBe(429);
        expect(response.body.code).toBe('TOO_MANY_REQUESTS');
        expect(response.headers['retry-after']).toBeDefined();
        expect(spec.paths['/openapi.json'].get.responses['429'].$ref).toBe('#/components/responses/RateLimited');
    });

    it('documents null for unknown transactions and the actual search response types', async () => {
        const app = appFor(routerFor(newFreshChain()));
        const unknown = await request(app).get('/api/transaction/' + 'f'.repeat(64) + '/status');
        expect(unknown.status).toBe(200);
        expect(unknown.body.status).toBe('unknown');
        expect(unknown.body.transaction).toBeNull();
        expect(spec.components.schemas.TransactionStatus.properties.transaction.anyOf.some(s => s.nullable && s.enum.includes(null))).toBe(true);
        const documentedTypes = spec.paths['/search'].get.responses['200'].content['application/json'].schema.properties.type.enum;
        for (const query of ['', '0', '999999', 'StarCoin']) {
            const response = await request(app).get('/api/search').query({ q: query });
            expect(response.status).toBe(200);
            expect(documentedTypes).toContain(response.body.type);
        }
    });
});
