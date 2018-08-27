#!/usr/bin/env node

/**
 * Modified by Denys Otrishko <shishugi@gmail.com>
 */

import { FileLogger, StdioLogger } from './logging';
import {
  MetaschemaService,
  MetaschemaServiceOptions,
} from './metaschema-service';
import { serve, ServeOptions } from './server';

const program = require('commander');
const packageJson = require('../package.json');

const defaultLspPort = 2089;
const numCPUs = require('os').cpus().length;

program
  .version(packageJson.version)
  .option('-s, --strict', 'enabled strict mode')
  .option(
    '-p, --port [port]',
    'specifies LSP port to use (' + defaultLspPort + ')',
    parseInt
  )
  .option(
    '-c, --cluster [num]',
    'number of concurrent cluster workers (defaults to number of CPUs, ' +
      numCPUs +
      ')',
    parseInt
  )
  .option('-t, --trace', 'print all requests and responses')
  .option('-l, --logfile [file]', 'log to this file')
  .parse(process.argv);

const options: ServeOptions & MetaschemaServiceOptions = {
  clusterSize: program.cluster || numCPUs,
  strict: program.strict || false,
  lspPort: program.port || defaultLspPort,
  logMessages: program.trace,
  logger: program.logfile ? new FileLogger(program.logfile) : new StdioLogger(),
};

serve(options, client => new MetaschemaService(client, options));
