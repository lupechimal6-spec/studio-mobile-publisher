// Convierte un proyecto de STUDIO MOBILE (formato del Serializer del juego) en un archivo .rbxlx
// que Roblox acepta en Open Cloud (Place Publishing).
//
// Formato del proyecto (lo genera ServerScriptService.StudioMobile.Serializer):
//   { fv, name, world: [nodos], services: { Lighting: [nodos], ServerScriptService: [...], ... } }
// Nodos:
//   { c: "S", n, sc: "Script"|"LocalScript"|"ModuleScript", src, k }   script
//   { c: "Folder", n, k }  ·  { c: "Model", n, cf, k }  ·  { c: "Rig", n, r, cf }
//   { c: "Part"|"WedgePart"|"SpawnLocation"|"Seat"|"TrussPart"|"CornerWedgePart", n, s, cf, col, m, t, r, a, cc, l, sh, k }
//   { c: "X", cl: "PointLight"|..., n, p: { prop: valor }, k }   objetos del catálogo

'use strict';

const MATERIALS = {
  Plastic: 256, SmoothPlastic: 272, Neon: 288, Wood: 512, WoodPlanks: 528, Marble: 784, Slate: 800,
  Concrete: 816, Granite: 832, Brick: 848, Pebble: 864, Cobblestone: 880, Rock: 896, Sandstone: 912,
  Basalt: 788, Asphalt: 1376, Pavement: 836, CorrodedMetal: 1040, DiamondPlate: 1056, Foil: 1072,
  Metal: 1088, Grass: 1280, LeafyGrass: 1284, Ice: 1536, Glacier: 1552, Snow: 1328, Sand: 1296,
  Fabric: 1312, Glass: 1568, ForceField: 1584,
};
const SHAPES = { Ball: 0, Block: 1, Cylinder: 2, Wedge: 3, CornerWedge: 4 };
const PART_CLASSES = new Set(['Part', 'WedgePart', 'SpawnLocation', 'Seat', 'TrussPart', 'CornerWedgePart']);

// Propiedades de los objetos del catálogo y su tipo en .rbxlx
const EXTRA = {
  ProximityPrompt: { ActionText: 'string', ObjectText: 'string', HoldDuration: 'float', MaxActivationDistance: 'float', RequiresLineOfSight: 'bool', Enabled: 'bool' },
  ClickDetector: { MaxActivationDistance: 'float' },
  PointLight: { Color: 'Color3', Brightness: 'float', Range: 'float', Shadows: 'bool', Enabled: 'bool' },
  SpotLight: { Color: 'Color3', Brightness: 'float', Range: 'float', Angle: 'float', Face: 'token', Shadows: 'bool', Enabled: 'bool' },
  SurfaceLight: { Color: 'Color3', Brightness: 'float', Range: 'float', Angle: 'float', Face: 'token', Enabled: 'bool' },
  Sound: { SoundId: 'Content', Volume: 'float', PlaybackSpeed: 'float', Looped: 'bool', Playing: 'bool' },
  ParticleEmitter: { Color: 'ColorSequence', Rate: 'float', LightEmission: 'float', Texture: 'Content', Enabled: 'bool' },
  Fire: { Color: 'Color3', SecondaryColor: 'Color3', Enabled: 'bool' },
  Smoke: { Color: 'Color3', Enabled: 'bool' },
  Sparkles: { SparkleColor: 'Color3', Enabled: 'bool' },
  Highlight: { FillColor: 'Color3', OutlineColor: 'Color3', FillTransparency: 'float', OutlineTransparency: 'float', Enabled: 'bool' },
  Decal: { Texture: 'Content', Face: 'token', Transparency: 'float' },
  Attachment: {},
  RemoteEvent: {},
  RemoteFunction: {},
  BindableEvent: {},
  Configuration: {},
  IntValue: { Value: 'int64' },
  NumberValue: { Value: 'double' },
  StringValue: { Value: 'string' },
  BoolValue: { Value: 'bool' },
};

// Dónde se ejecutan los LocalScript de "StarterPlayer" en el editor → StarterPlayerScripts en Roblox
const SERVICE_ORDER = ['Lighting', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer'];

const MAX_NODES = 20000;
const MAX_NAME = 100;

function xmlEscape(s) {
  return String(s)
    // Caracteres no permitidos en XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cdata(s) {
  const clean = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  return '<![CDATA[' + clean.split(']]>').join(']]]]><![CDATA[>') + ']]>';
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function name(v, def) {
  if (typeof v !== 'string' || v.length === 0) return def;
  return v.slice(0, MAX_NAME);
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return [163, 162, 165];
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [163, 162, 165];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function assetUrl(v) {
  if (typeof v !== 'string') return '';
  if (/^rbxassetid:\/\/\d{1,18}$/.test(v)) return v;
  if (/^rbxasset:\/\/textures\/[\w/.\-]+$/.test(v) && !v.includes('..')) return v;
  return '';
}

class Writer {
  constructor() {
    this.out = [];
    this.ref = 0;
    this.count = 0;
    this.warnings = new Set();
  }

  push(s) {
    this.out.push(s);
  }

  open(cls) {
    this.count += 1;
    if (this.count > MAX_NODES) throw new Error(`El proyecto tiene demasiados objetos (máx. ${MAX_NODES}).`);
    this.ref += 1;
    this.push(`<Item class="${cls}" referent="RBX${this.ref}"><Properties>`);
  }

  endProps() {
    this.push('</Properties>');
  }

  close() {
    this.push('</Item>');
  }

  prop(type, pname, value) {
    const n = xmlEscape(pname);
    switch (type) {
      case 'string':
        this.push(`<string name="${n}">${xmlEscape(value)}</string>`);
        break;
      case 'bool':
        this.push(`<bool name="${n}">${value ? 'true' : 'false'}</bool>`);
        break;
      case 'float':
        this.push(`<float name="${n}">${num(value)}</float>`);
        break;
      case 'double':
        this.push(`<double name="${n}">${num(value)}</double>`);
        break;
      case 'int':
        this.push(`<int name="${n}">${Math.round(num(value))}</int>`);
        break;
      case 'int64':
        this.push(`<int64 name="${n}">${Math.round(clamp(num(value), -1e12, 1e12))}</int64>`);
        break;
      case 'token':
        this.push(`<token name="${n}">${Math.round(num(value))}</token>`);
        break;
      case 'Content': {
        const url = assetUrl(value);
        this.push(url ? `<Content name="${n}"><url>${xmlEscape(url)}</url></Content>` : `<Content name="${n}"><null></null></Content>`);
        break;
      }
      case 'Color3': {
        const [r, g, b] = hexToRgb(value);
        this.push(`<Color3 name="${n}"><R>${r / 255}</R><G>${g / 255}</G><B>${b / 255}</B></Color3>`);
        break;
      }
      case 'Color3uint8': {
        const [r, g, b] = hexToRgb(value);
        const packed = ((0xff << 24) >>> 0) + (r << 16) + (g << 8) + b;
        this.push(`<Color3uint8 name="${n}">${packed >>> 0}</Color3uint8>`);
        break;
      }
      case 'ColorSequence': {
        const [r, g, b] = hexToRgb(value).map((c) => c / 255);
        this.push(`<ColorSequence name="${n}">0 ${r} ${g} ${b} 0 1 ${r} ${g} ${b} 0 </ColorSequence>`);
        break;
      }
      case 'Vector3': {
        const v = Array.isArray(value) ? value : [0, 0, 0];
        this.push(`<Vector3 name="${n}"><X>${num(v[0])}</X><Y>${num(v[1])}</Y><Z>${num(v[2])}</Z></Vector3>`);
        break;
      }
      case 'CFrame': {
        const c = Array.isArray(value) && value.length === 12 ? value.map((x) => num(x)) : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
        const keys = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];
        this.push(`<CoordinateFrame name="${n}">${keys.map((k, i) => `<${k}>${c[i]}</${k}>`).join('')}</CoordinateFrame>`);
        break;
      }
      case 'PivotCFrame': {
        const c = Array.isArray(value) && value.length === 12 ? value.map((x) => num(x)) : null;
        if (!c) break;
        const keys = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];
        this.push(`<OptionalCoordinateFrame name="${n}"><CFrame>${keys.map((k, i) => `<${k}>${c[i]}</${k}>`).join('')}</CFrame></OptionalCoordinateFrame>`);
        break;
      }
      case 'ProtectedString':
        this.push(`<ProtectedString name="${n}">${cdata(value)}</ProtectedString>`);
        break;
      default:
        break;
    }
  }
}

function writeChildren(w, list, ctx) {
  if (!Array.isArray(list)) return;
  for (const node of list) writeNode(w, node, ctx);
}

function writeNode(w, node, ctx) {
  if (!node || typeof node !== 'object') return;
  const c = node.c;

  if (c === 'S') {
    const sc = ['Script', 'LocalScript', 'ModuleScript'].includes(node.sc) ? node.sc : null;
    if (!sc) return;
    w.open(sc);
    w.prop('string', 'Name', name(node.n, sc));
    w.prop('ProtectedString', 'Source', typeof node.src === 'string' ? node.src.slice(0, 200000) : '');
    w.endProps();
    writeChildren(w, node.k, ctx);
    w.close();
    return;
  }

  if (c === 'Folder') {
    w.open('Folder');
    w.prop('string', 'Name', name(node.n, 'Folder'));
    w.endProps();
    writeChildren(w, node.k, ctx);
    w.close();
    return;
  }

  if (c === 'Model') {
    w.open('Model');
    w.prop('string', 'Name', name(node.n, 'Model'));
    w.prop('PivotCFrame', 'WorldPivotData', node.cf);
    w.endProps();
    writeChildren(w, node.k, ctx);
    w.close();
    return;
  }

  if (c === 'Rig') {
    // Los rigs se crean con HumanoidDescription en el juego; aquí se deja un modelo vacío con el nombre
    w.warnings.add('Los rigs R6/R15 no se publican: vuelve a insertarlos en Roblox Studio si los necesitas.');
    w.open('Model');
    w.prop('string', 'Name', name(node.n, 'Rig'));
    w.endProps();
    w.close();
    return;
  }

  if (PART_CLASSES.has(c)) {
    w.open(c);
    w.prop('string', 'Name', name(node.n, c));
    w.prop('CFrame', 'CFrame', node.cf);
    w.prop('Vector3', 'size', Array.isArray(node.s) ? node.s.map((v) => clamp(num(v, 1), 0.001, 2048)) : [4, 1, 2]);
    w.prop('Color3uint8', 'Color3uint8', node.col);
    w.prop('token', 'Material', MATERIALS[node.m] ?? 256);
    w.prop('float', 'Transparency', clamp(num(node.t, 0), 0, 1));
    w.prop('float', 'Reflectance', clamp(num(node.r, 0), 0, 1));
    w.prop('bool', 'Anchored', node.a !== false);
    w.prop('bool', 'CanCollide', node.cc !== false);
    w.prop('bool', 'Locked', node.l === true);
    w.prop('token', 'TopSurface', 0);
    w.prop('token', 'BottomSurface', 0);
    if (c === 'Part' && node.sh && SHAPES[node.sh] !== undefined) w.prop('token', 'shape', SHAPES[node.sh]);
    if (c === 'SpawnLocation') {
      // En el editor está desactivado; en el juego publicado debe funcionar
      w.prop('bool', 'Enabled', true);
      w.prop('bool', 'Neutral', true);
      ctx.hasSpawn = true;
    }
    w.endProps();
    writeChildren(w, node.k, ctx);
    w.close();
    return;
  }

  if (c === 'X') {
    const cls = node.cl;
    const props = EXTRA[cls];
    if (!props) return;
    w.open(cls);
    w.prop('string', 'Name', name(node.n, cls));
    const p = node.p && typeof node.p === 'object' && !Array.isArray(node.p) ? node.p : {};
    for (const [pname, type] of Object.entries(props)) {
      if (p[pname] === undefined || p[pname] === null) continue;
      const v = p[pname];
      if (type === 'bool' && typeof v !== 'boolean') continue;
      if (type === 'string' && typeof v !== 'string') continue;
      w.prop(type, pname, type === 'string' ? v.slice(0, 200) : v);
    }
    w.endProps();
    writeChildren(w, node.k, ctx);
    w.close();
  }
}

function writeService(w, cls, children, ctx, extra) {
  w.open(cls);
  w.prop('string', 'Name', cls);
  if (extra) extra();
  w.endProps();
  writeChildren(w, children, ctx);
  w.close();
}

/**
 * @param {object} project  proyecto decodificado
 * @returns {{ xml: string, objects: number, warnings: string[] }}
 */
function projectToRbxlx(project) {
  if (!project || typeof project !== 'object') throw new Error('Proyecto no válido.');
  const w = new Writer();
  const ctx = { hasSpawn: false };
  const services = project.services && typeof project.services === 'object' ? project.services : {};

  w.push('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">');
  w.push('<External>null</External><External>nil</External>');

  writeService(w, 'Workspace', project.world, ctx);
  writeService(w, 'Players', [], ctx);

  for (const svc of SERVICE_ORDER) {
    const list = Array.isArray(services[svc]) ? services[svc] : [];
    if (svc === 'StarterPlayer') {
      // En el editor los LocalScript van "en StarterPlayer"; en Roblox deben estar en StarterPlayerScripts
      w.open('StarterPlayer');
      w.prop('string', 'Name', 'StarterPlayer');
      w.endProps();
      w.open('StarterPlayerScripts');
      w.prop('string', 'Name', 'StarterPlayerScripts');
      w.endProps();
      writeChildren(w, list, ctx);
      w.close();
      w.open('StarterCharacterScripts');
      w.prop('string', 'Name', 'StarterCharacterScripts');
      w.endProps();
      w.close();
      w.close();
    } else {
      writeService(w, svc, list, ctx);
    }
  }

  w.push('</roblox>');
  if (!ctx.hasSpawn) w.warnings.add('No hay SpawnLocation: los jugadores aparecerán en el centro del mapa.');
  return { xml: w.out.join(''), objects: w.count, warnings: [...w.warnings] };
}

module.exports = { projectToRbxlx, EXTRA, MATERIALS };
