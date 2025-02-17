import {Report, MessageName, miscUtils, Configuration, formatUtils} from '@yarnpkg/core';
import {Filename, PortablePath, npath, ppath, xfs}                  from '@yarnpkg/fslib';
import {parseSyml, stringifySyml}                                   from '@yarnpkg/parsers';
import {PnpApi}                                                     from '@yarnpkg/pnp';
import chalk                                                        from 'chalk';
import {UsageError}                                                 from 'clipanion';
import capitalize                                                   from 'lodash/capitalize';
import startCase                                                    from 'lodash/startCase';

import {dynamicRequire}                                             from './dynamicRequire';
import {BASE_SDKS}                                                  from './sdks/base';
import {COC_VIM_SDKS}                                               from './sdks/cocvim';
import {VSCODE_SDKS}                                                from './sdks/vscode';

export const SDK_FOLDER = `.yarn/sdks` as PortablePath;

export const INTEGRATIONS_FILE = `integrations.yml` as Filename;

export const SUPPORTED_INTEGRATIONS = new Map([
  [`vim`, COC_VIM_SDKS],
  [`vscode`, VSCODE_SDKS],
] as const);

export const getDisplayName = (name: string) =>
  startCase(name).split(` `).map(word => capitalize(word)).join(` `);

export const validateIntegrations = (integrations: Set<string>) => {
  const unsupportedIntegrations: Array<string> = [];

  for (const integration of integrations) {
    if (!SUPPORTED_INTEGRATIONS.has(integration as SupportedIntegration)) {
      unsupportedIntegrations.push(integration);
    }
  }

  if (unsupportedIntegrations.length > 0) {
    throw new UsageError(`No supported integrations with the following names could be found: ${unsupportedIntegrations.join(`, `)}. Run \`yarn sdks -h\` to see the list of supported integrations.`);
  }
};

export type MapKey<S> = S extends Map<infer K, any> ? K : never;

export type SupportedIntegration = MapKey<typeof SUPPORTED_INTEGRATIONS>;

export class IntegrationsFile {
  public integrations: Set<SupportedIntegration> = new Set();

  public raw: {[key: string]: any} = {};

  static async find(projectRoot: PortablePath) {
    const targetFolder = ppath.join(projectRoot, SDK_FOLDER);

    const integrationPath = ppath.join(targetFolder, INTEGRATIONS_FILE);
    if (!xfs.existsSync(integrationPath))
      return null;

    const integrationsFile = new IntegrationsFile();
    await integrationsFile.loadFile(integrationPath);

    return integrationsFile;
  }

  async loadFile(path: PortablePath) {
    const content = await xfs.readFilePromise(path, `utf8`);

    let data;
    try {
      data = parseSyml(content || `{}`);
    } catch (error) {
      error.message += ` (when parsing ${path})`;
      throw error;
    }

    this.load(data);
  }

  load(data: any) {
    if (typeof data !== `object` || data === null)
      throw new Error(`Utterly invalid integrations file data (${data})`);

    this.raw = data;

    if (Array.isArray(data.integrations)) {
      this.integrations = new Set(data.integrations);
      validateIntegrations(this.integrations);
    }
  }

  exportTo(data: {[key: string]: any}) {
    if (this.integrations.size > 0)
      data.integrations = [...this.integrations];

    return data;
  }

  async persist(dir: PortablePath) {
    const data = {};
    this.exportTo(data);

    const path = ppath.join(dir, INTEGRATIONS_FILE);
    let content = `# This file is automatically generated by @yarnpkg/sdks.\n# Manual changes might be lost!\n\n`;
    content += stringifySyml(data);

    await xfs.mkdirPromise(ppath.dirname(path), {recursive: true});
    await xfs.changeFilePromise(path, content, {
      automaticNewlines: true,
    });
  }
}

type TemplateOptions = {
  setupEnv?: boolean;
  usePnpify?: boolean;
  wrapModule?: string;
};

const TEMPLATE = (relPnpApiPath: PortablePath, module: string, {setupEnv = false, usePnpify = false, wrapModule}: TemplateOptions) => [
  `#!/usr/bin/env node\n`,
  `\n`,
  `const {existsSync} = require(\`fs\`);\n`,
  `const {createRequire, register} = require(\`module\`);\n`,
  `const {resolve} = require(\`path\`);\n`,
  `const {pathToFileURL} = require(\`url\`);\n`,
  `\n`,
  `const relPnpApiPath = ${JSON.stringify(npath.fromPortablePath(relPnpApiPath))};\n`,
  `\n`,
  `const absPnpApiPath = resolve(__dirname, relPnpApiPath);\n`,
  `const absUserWrapperPath = resolve(__dirname, \`./sdk.user.cjs\`);\n`,
  `const absRequire = createRequire(absPnpApiPath);\n`,
  `\n`,
  `const absPnpLoaderPath = resolve(absPnpApiPath, \`../.pnp.loader.mjs\`);\n`,
  `const isPnpLoaderEnabled = existsSync(absPnpLoaderPath);\n`,
  `\n`,
  `if (existsSync(absPnpApiPath)) {\n`,
  `  if (!process.versions.pnp) {\n`,
  `    // Setup the environment to be able to require ${module}\n`,
  `    require(absPnpApiPath).setup();\n`,
  `    if (isPnpLoaderEnabled && register) {\n`,
  `      register(pathToFileURL(absPnpLoaderPath));\n`,
  `    }\n`,
  `  }\n`,
  ...(setupEnv ? [
    `\n`,
    `  if (typeof global[\`__yarnpkg_sdk_has_setup_env__\`] === \`undefined\`) {\n`,
    `    Object.defineProperty(global, \`__yarnpkg_sdk_has_setup_env__\`, {configurable: true, value: true});\n`,
    `\n`,
    `    process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || \`\`;\n`,
    `    process.env.NODE_OPTIONS += \` -r \${absPnpApiPath}\`;\n`,
    `  }\n`,
  ] : []),
  ...(usePnpify ? [
    `\n`,
    `  let pnpifyResolution;\n`,
    `  try {\n`,
    `    pnpifyResolution = absRequire.resolve(\`@yarnpkg/pnpify\`);\n`,
    `  } catch (err) {}\n`,
    `  \n`,
    `  if (pnpifyResolution) {\n`,
    `    if (typeof global[\`__yarnpkg_sdk_is_using_pnpify__\`] === \`undefined\`) {\n`,
    `      Object.defineProperty(global, \`__yarnpkg_sdk_is_using_pnpify__\`, {configurable: true, value: true});\n`,
    `\n`,
    `      process.env.NODE_OPTIONS += \` -r \${pnpifyResolution}\`;\n`,
    `\n`,
    `      // Apply PnPify to the current process\n`,
    `      absRequire(pnpifyResolution).patchFs();\n`,
    `    }\n`,
    `  }\n`,
  ] : []),
  `}\n`,
  `\n`,
  `const wrapWithUserWrapper = existsSync(absUserWrapperPath)\n`,
  `  ? exports => absRequire(absUserWrapperPath)(exports)\n`,
  `  : exports => exports;\n`,
  `\n`,
  ...(wrapModule ? [
    `const moduleWrapper = exports => {\n`,
    `  return wrapWithUserWrapper(moduleWrapperFn(exports));\n`,
    `};\n`,
    `\n`,
    `const moduleWrapperFn = ${wrapModule.trim().replace(/^ {4}/gm, ``)}\n`,
    `\n`,
  ] : []),
  `// Defer to the real ${module} your application uses\n`,
  ...(wrapModule ? [
    `module.exports = moduleWrapper(absRequire(\`${module}\`));\n`,
  ] : [
    `module.exports = wrapWithUserWrapper(absRequire(\`${module}\`));\n`,
  ]),
].join(``);

export type GenerateBaseWrapper = (pnpApi: PnpApi, target: PortablePath) => Promise<Wrapper>;

export type GenerateIntegrationWrapper = (pnpApi: PnpApi, target: PortablePath, wrapper: Wrapper) => Promise<void>;

export type GenerateDefaultWrapper = (pnpApi: PnpApi, target: PortablePath) => Promise<void>;

export type SupportedSdk =
  | `@astrojs/language-server`
  | `eslint`
  | `prettier`
  | `relay-compiler`
  | `typescript-language-server`
  | `typescript`
  | `svelte-language-server`
  | `flow-bin`;

export type BaseSdks = Array<[
  SupportedSdk,
  GenerateBaseWrapper,
]>;

export type IntegrationSdks = Array<
  | [null, GenerateDefaultWrapper | null]
  | [SupportedSdk, GenerateIntegrationWrapper | null]
>;

export type PackageExports =
  | {[key: string]: PackageExports}
  | Array<PackageExports>
  | string
  | null;

export class Wrapper {
  private name: PortablePath;

  private pnpApi: PnpApi;
  private target: PortablePath;

  private paths: Map<PortablePath, PortablePath> = new Map();

  public readonly manifest: Record<string, any>;

  constructor(name: PortablePath, {pnpApi, target, manifestOverrides = {}}: {pnpApi: PnpApi, target: PortablePath, manifestOverrides?: Record<string, any>}) {
    this.name = name;

    this.pnpApi = pnpApi;
    this.target = target;

    this.manifest = this.loadManifest();
    Object.assign(this.manifest, manifestOverrides);
  }

  private loadManifest() {
    const topLevelInformation = this.pnpApi.getPackageInformation(this.pnpApi.topLevel)!;
    const dependencyReference = topLevelInformation.packageDependencies.get(this.name)!;

    const pkgInformation = this.pnpApi.getPackageInformation(this.pnpApi.getLocator(this.name, dependencyReference));
    if (pkgInformation === null)
      throw new Error(`Assertion failed: Package ${this.name} isn't a dependency of the top-level`);

    const manifestPath = npath.join(pkgInformation.packageLocation, Filename.manifest);
    const manifest = dynamicRequire(manifestPath);

    return {
      name: this.name,
      version: `${manifest.version}-sdk`,
      main: manifest.main,
      type: `commonjs`,
      bin: manifest.bin,
      exports: manifest.exports,
    };
  }

  async writeDefaults() {
    if (this.manifest.main)
      await this.writeFile(ppath.normalize(this.manifest.main as PortablePath), {requirePath: PortablePath.dot});

    if (this.manifest.exports)
      await this.writePackageExports();

    if (this.manifest.bin)
      await this.writePackageBinaries();

    await this.writeManifest();
  }

  async writePackageBinaries() {
    if (typeof this.manifest.bin === `string`) {
      await this.writeBinary(ppath.normalize(this.manifest.bin as PortablePath));
    } else {
      for (const relPackagePath of Object.values(this.manifest.bin)) {
        await this.writeBinary(ppath.normalize(relPackagePath as PortablePath));
      }
    }
  }

  async writePackageExports(packageExports: PackageExports = this.manifest.exports, requirePath = PortablePath.dot) {
    if (typeof packageExports === `string`) {
      if (!packageExports.includes(`*`)) {
        await this.writeFile(ppath.normalize(packageExports as PortablePath), {requirePath});
      }
    } else if (Array.isArray(packageExports)) {
      await Promise.all(
        packageExports.map(packageExport => this.writePackageExports(packageExport, requirePath)),
      );
    } else if (packageExports !== null) {
      await Promise.all(
        Object.entries(packageExports).map(async ([key, value]) => {
          if (key.startsWith(`.`)) {
            await this.writePackageExports(value, key as PortablePath);
          } else {
            await this.writePackageExports(value, requirePath);
          }
        }),
      );
    }
  }

  async writeManifest() {
    const topLevelInformation = this.pnpApi.getPackageInformation(this.pnpApi.topLevel)!;
    const projectRoot = npath.toPortablePath(topLevelInformation.packageLocation);

    const absWrapperPath = ppath.join(this.target, this.name, `package.json`);
    const relProjectPath = ppath.relative(projectRoot, absWrapperPath);

    await xfs.mkdirPromise(ppath.dirname(absWrapperPath), {recursive: true});
    await xfs.writeJsonPromise(absWrapperPath, this.manifest);

    this.paths.set(Filename.manifest, relProjectPath);
  }

  async writeBinary(relPackagePath: PortablePath, options: TemplateOptions & {requirePath?: PortablePath} = {}) {
    await this.writeFile(relPackagePath, {...options, mode: 0o755});
  }

  async writeFile(relPackagePath: PortablePath, options: TemplateOptions & {requirePath?: PortablePath, mode?: number} = {}) {
    const topLevelInformation = this.pnpApi.getPackageInformation(this.pnpApi.topLevel)!;
    const projectRoot = npath.toPortablePath(topLevelInformation.packageLocation);

    const absWrapperPath = ppath.join(this.target, this.name, relPackagePath);
    const relProjectPath = ppath.relative(projectRoot, absWrapperPath);

    const absPnpApiPath = npath.toPortablePath(this.pnpApi.resolveRequest(`pnpapi`, null)!);
    const relPnpApiPath = ppath.relative(ppath.dirname(absWrapperPath), absPnpApiPath);

    const moduleReqPath = ppath.join(this.name, options.requirePath ?? relPackagePath);
    const wrapperScript = TEMPLATE(relPnpApiPath, moduleReqPath, options);

    await xfs.mkdirPromise(ppath.dirname(absWrapperPath), {recursive: true});
    await xfs.writeFilePromise(absWrapperPath, wrapperScript, {mode: options.mode});

    this.paths.set(relPackagePath, relProjectPath);

    return absWrapperPath;
  }

  getProjectPathTo(relPackagePath: PortablePath) {
    const relProjectPath = this.paths.get(relPackagePath);

    if (typeof relProjectPath === `undefined`)
      throw new Error(`Assertion failed: Expected path to have been registered`);

    return relProjectPath;
  }
}

type AllIntegrations = {
  requestedIntegrations: Set<SupportedIntegration>;
  preexistingIntegrations: Set<SupportedIntegration>;
};

export const generateSdk = async (pnpApi: PnpApi, {requestedIntegrations, preexistingIntegrations}: AllIntegrations, {report, onlyBase, verbose, configuration}: {report: Report, onlyBase: boolean, verbose: boolean, configuration: Configuration}): Promise<void> => {
  const Mark = formatUtils.mark(configuration);

  const topLevelInformation = pnpApi.getPackageInformation(pnpApi.topLevel)!;
  const projectRoot = npath.toPortablePath(topLevelInformation.packageLocation);

  const targetFolder = ppath.join(projectRoot, SDK_FOLDER);

  const allIntegrations = new Set([
    ...requestedIntegrations,
    ...preexistingIntegrations,
  ]);

  if (xfs.existsSync(targetFolder)) {
    report.reportWarning(MessageName.UNNAMED, `Cleaning up the existing SDK files...`);
    await xfs.removePromise(targetFolder);
  }

  const integrationsFile = new IntegrationsFile();
  integrationsFile.integrations = allIntegrations;
  await integrationsFile.persist(targetFolder);

  const integrationSdks = miscUtils.mapAndFilter(SUPPORTED_INTEGRATIONS, ([integration, sdk]) => {
    if (!allIntegrations.has(integration))
      return miscUtils.mapAndFilter.skip;

    return sdk;
  });

  await report.startTimerPromise(`Generating SDKs inside ${formatUtils.pretty(configuration, SDK_FOLDER, formatUtils.Type.PATH)}`, async () => {
    const skipped = [];

    for (const sdks of integrationSdks) {
      const defaultSdk = sdks.find(sdk => sdk[0] === null);
      if (!defaultSdk)
        continue;

      const [, generateDefaultWrapper] = defaultSdk;
      await (generateDefaultWrapper as GenerateDefaultWrapper | null)?.(pnpApi, targetFolder);
    }

    for (const [pkgName, generateBaseWrapper] of BASE_SDKS) {
      const displayName = getDisplayName(pkgName);

      if (topLevelInformation.packageDependencies.has(pkgName)) {
        report.reportInfo(MessageName.UNNAMED, `${Mark.Check} ${displayName}`);
        const wrapper = await generateBaseWrapper(pnpApi, targetFolder);

        for (const sdks of integrationSdks) {
          const sdk = sdks.find(sdk => sdk[0] === pkgName);
          if (!sdk)
            continue;

          const [, generateIntegrationWrapper] = sdk;
          if (!generateIntegrationWrapper)
            continue;

          await generateIntegrationWrapper(pnpApi, targetFolder, wrapper);
        }
      } else {
        skipped.push(displayName);
      }
    }

    if (skipped.length > 0) {
      if (verbose) {
        for (const displayName of skipped) {
          report.reportWarning(MessageName.UNNAMED, `${chalk.yellow(`•`)} ${displayName} (dependency not found; skipped)`);
        }
      } else {
        report.reportWarning(MessageName.UNNAMED, `${chalk.yellow(`•`)} ${skipped.length} SDKs were skipped based on your root dependencies`);
      }
    }
  });

  if (allIntegrations.size > 0) {
    await report.startTimerPromise(`Generating settings`, async () => {
      for (const integration of allIntegrations) {
        if (preexistingIntegrations.has(integration)) {
          report.reportInfo(MessageName.UNNAMED, `${Mark.Check} ${getDisplayName(integration)} (updated 🔼)`);
        } else {
          report.reportInfo(MessageName.UNNAMED, `${Mark.Check} ${getDisplayName(integration)} (new ✨)`);
        }
      }
    });
  }
};
