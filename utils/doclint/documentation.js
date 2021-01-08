/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

const md = require('../markdown');

/** @typedef {import('../markdown').MarkdownNode} MarkdownNode */

/**
 * @typedef {{
  *   name: string,
  *   args: ParsedType | null,
  *   retType: ParsedType | null,
  *   template: ParsedType | null,
  *   union: ParsedType | null,
  *   next: ParsedType | null,
  * }} ParsedType
  */

/**
 * @typedef {function({
  *   clazz?: Documentation.Class,
  *   member?: Documentation.Member,
  *   param?: string,
  *   option?: string
  * }): string} Renderer
  */
 
class Documentation {
  /**
   * @param {!Array<!Documentation.Class>} classesArray
   */
  constructor(classesArray) {
    this.classesArray = classesArray;
    /** @type {!Map<string, !Documentation.Class>} */
    this.classes = new Map();
    this.index();
  }

  /**
   * @param {string[]} errors
   */
  copyDocsFromSuperclasses(errors) {
    for (const [name, clazz] of this.classes.entries()) {
      clazz.validateOrder(errors, clazz);

      if (!clazz.extends || clazz.extends === 'EventEmitter' || clazz.extends === 'Error')
        continue;
      const superClass = this.classes.get(clazz.extends);
      if (!superClass) {
        errors.push(`Undefined superclass: ${superClass} in ${name}`);
        continue;
      }
      for (const memberName of clazz.members.keys()) {
        if (superClass.members.has(memberName))
          errors.push(`Member documentation overrides base: ${name}.${memberName} over ${clazz.extends}.${memberName}`);
      }

      clazz.membersArray = [...clazz.membersArray, ...superClass.membersArray.map(c => c.clone())];
      clazz.index();
    }
  }

  /**
   * @param {string} lang
   */
  filterForLanguage(lang) {
    const classesArray = [];
    for (const clazz of this.classesArray) {
      if (clazz.langs && !clazz.langs.has(lang))
        continue;
      clazz.filterForLanguage(lang);
      classesArray.push(clazz);
    }
    this.classesArray = classesArray;
    this.index();
  }

  index() {
    for (const cls of this.classesArray) {
      this.classes.set(cls.name, cls);
      cls.index();
    }
  }

  /**
   * @param {Renderer} linkRenderer
   */
  setLinkRenderer(linkRenderer) {
    // @type {Map<string, Documentation.Class>}
    const classesMap = new Map();
    const membersMap = new Map();
    for (const clazz of this.classesArray) {
      classesMap.set(clazz.name, clazz);
      for (const member of clazz.membersArray)
        membersMap.set(`${member.kind}: ${clazz.name}.${member.name}`, member);
    }
    this._patchLinks = nodes => patchLinks(nodes, classesMap, membersMap, linkRenderer);

    for (const clazz of this.classesArray)
      clazz.visit(item => this._patchLinks(item.spec));
  }

  /**
   * @param {MarkdownNode[]} nodes
   */
  renderLinksInText(nodes) {
    this._patchLinks(nodes);
  }

  generateSourceCodeComments() {
    for (const clazz of this.classesArray)
      clazz.visit(item => item.comment = generateSourceCodeComment(item.spec));
  }

}

Documentation.Class = class {
  /**
   * @param {?Set<string>} langs
   * @param {string} name
   * @param {!Array<!Documentation.Member>} membersArray
   * @param {?string=} extendsName
   * @param {MarkdownNode[]=} spec
   */
  constructor(langs, name, membersArray, extendsName = null, spec = undefined) {
    this.langs = langs;
    this.name = name;
    this.membersArray = membersArray;
    this.spec = spec;
    this.extends = extendsName;
    this.comment =  '';
    this.index();
    const match = name.match(/(JS|CDP|[A-Z])(.*)/);
    this.varName = match[1].toLowerCase() + match[2];
  }

  index() {
    /** @type {!Map<string, !Documentation.Member>} */
    this.members = new Map();
    /** @type {!Map<string, !Documentation.Member>} */
    this.properties = new Map();
    /** @type {!Array<!Documentation.Member>} */
    this.propertiesArray = [];
    /** @type {!Map<string, !Documentation.Member>} */
    this.methods = new Map();
    /** @type {!Array<!Documentation.Member>} */
    this.methodsArray = [];
    /** @type {!Map<string, !Documentation.Member>} */
    this.events = new Map();
    /** @type {!Array<!Documentation.Member>} */
    this.eventsArray = [];

    for (const member of this.membersArray) {
      this.members.set(member.name, member);
      if (member.kind === 'method') {
        this.methods.set(member.name, member);
        this.methodsArray.push(member);
      } else if (member.kind === 'property') {
        this.properties.set(member.name, member);
        this.propertiesArray.push(member);
      } else if (member.kind === 'event') {
        this.events.set(member.name, member);
        this.eventsArray.push(member);
      }
      member.clazz = this;
      member.index();
    }
  }

  /**
   * @param {string} lang
   */
  filterForLanguage(lang) {
    const membersArray = [];
    for (const member of this.membersArray) {
      if (member.langs && !member.langs.has(lang))
        continue;
      member.filterForLanguage(lang);
      membersArray.push(member);
    }
    this.membersArray = membersArray;
  }

  validateOrder(errors, cls) {
    const members = this.membersArray;
    // Events should go first.
    let eventIndex = 0;
    for (; eventIndex < members.length && members[eventIndex].kind === 'event'; ++eventIndex);
    for (; eventIndex < members.length && members[eventIndex].kind !== 'event'; ++eventIndex);
    if (eventIndex < members.length)
      errors.push(`Events should go first. Event '${members[eventIndex].name}' in class ${cls.name} breaks order`);

    // Constructor should be right after events and before all other members.
    const constructorIndex = members.findIndex(member => member.kind === 'method' && member.name === 'constructor');
    if (constructorIndex > 0 && members[constructorIndex - 1].kind !== 'event')
      errors.push(`Constructor of ${cls.name} should go before other methods`);

    // Events should be sorted alphabetically.
    for (let i = 0; i < members.length - 1; ++i) {
      const member1 = this.membersArray[i];
      const member2 = this.membersArray[i + 1];
      if (member1.kind !== 'event' || member2.kind !== 'event')
        continue;
      if (member1.name > member2.name)
        errors.push(`Event '${member1.name}' in class ${this.name} breaks alphabetic ordering of events`);
    }

    // All other members should be sorted alphabetically.
    for (let i = 0; i < members.length - 1; ++i) {
      const member1 = this.membersArray[i];
      const member2 = this.membersArray[i + 1];
      if (member1.kind === 'event' || member2.kind === 'event')
        continue;
      if (member1.kind === 'method' && member1.name === 'constructor')
        continue;
      if (member1.name.replace(/^\$+/, '$') > member2.name.replace(/^\$+/, '$')) {
        let memberName1 = `${this.name}.${member1.name}`;
        if (member1.kind === 'method')
          memberName1 += '()';
        let memberName2 = `${this.name}.${member2.name}`;
        if (member2.kind === 'method')
          memberName2 += '()';
        errors.push(`Bad alphabetic ordering of ${this.name} members: ${memberName1} should go after ${memberName2}`);
      }
    }
  }

  /** 
   * @param {function(Documentation.Member|Documentation.Class): void} visitor
   */
  visit(visitor) {
    visitor(this);
    for (const p of this.propertiesArray)
      p.visit(visitor);
    for (const m of this.methodsArray)
      m.visit(visitor);
    for (const e of this.eventsArray)
      e.visit(visitor);
  }
};

Documentation.Member = class {
  /**
   * @param {string} kind
   * @param {?Set<string>} langs
   * @param {string} name
   * @param {?Documentation.Type} type
   * @param {!Array<!Documentation.Member>} argsArray
   * @param {MarkdownNode[]=} spec
   * @param {boolean=} required
   * @param {string[]=} templates
   */
  constructor(kind, langs, name, type, argsArray, spec = undefined, required = true, templates = []) {
    this.kind = kind;
    this.langs = langs;
    this.name = name;
    this.type = type;
    this.spec = spec;
    this.argsArray = argsArray;
    this.required = required;
    this.comment =  '';
    /** @type {!Map<string, !Documentation.Member>} */
    this.args = new Map();
    this.index();
    /** @type {!Documentation.Class} */
    this.clazz = null;
    this.deprecated = false;
    if (spec) {
      md.visitAll(spec, node => {
        if (node.text && node.text.includes('**DEPRECATED**'))
          this.deprecated = true;
      });
    };
    this.async = false;
  }

  index() {
    this.args = new Map();
    for (const arg of this.argsArray) {
      this.args.set(arg.name, arg);
      if (arg.name === 'options')
        arg.type.properties.sort((p1, p2) => p1.name.localeCompare(p2.name));
    }
  }

    /**
   * @param {string} lang
   */
  filterForLanguage(lang) {
    const argsArray = [];
    for (const arg of this.argsArray) {
      if (arg.langs && !arg.langs.has(lang))
        continue;
      arg.filterForLanguage(lang);
      argsArray.push(arg);
    }
    this.argsArray = argsArray;
  }

  clone() {
    const result = new Documentation.Member(this.kind, this.langs, this.name, this.type, this.argsArray, this.spec, this.required);
    result.async = this.async;
    return result;
  }

  /**
   * @param {?Set<string>} langs
   * @param {string} name
   * @param {!Array<!Documentation.Member>} argsArray
   * @param {?Documentation.Type} returnType
   * @param {MarkdownNode[]=} spec
   * @return {!Documentation.Member}
   */
  static createMethod(langs, name, argsArray, returnType, spec) {
    return new Documentation.Member('method', langs, name, returnType, argsArray, spec);
  }

  /**
   * @param {?Set<string>} langs
   * @param {string} name
   * @param {!Documentation.Type} type
   * @param {MarkdownNode[]=} spec
   * @param {boolean=} required
   * @return {!Documentation.Member}
   */
  static createProperty(langs, name, type, spec, required) {
    return new Documentation.Member('property', langs, name, type, [], spec, required);
  }

  /**
   * @param {?Set<string>} langs
   * @param {string} name
   * @param {?Documentation.Type=} type
   * @param {MarkdownNode[]=} spec
   * @return {!Documentation.Member}
   */
  static createEvent(langs, name, type = null, spec) {
    return new Documentation.Member('event', langs, name, type, [], spec);
  }

  /** 
   * @param {function(Documentation.Member|Documentation.Class): void} visitor
   */
  visit(visitor) {
    visitor(this);
    if (this.type)
      this.type.visit(visitor);
    for (const arg of this.argsArray)
      arg.visit(visitor);
  }
};

Documentation.Type = class {
  /**
   * @param {string} expression
   * @param {!Array<!Documentation.Member>=} properties
   * @return {Documentation.Type}
   */
  static parse(expression, properties = []) {
    expression = expression.replace(/\\\(/g, '(').replace(/\\\)/g, ')');
    const type = Documentation.Type.fromParsedType(parseTypeExpression(expression));
    type.expression = expression;
    if (type.name === 'number')
      throw new Error('Number types should be either int or float, not number in: ' + expression);
    if (!properties.length)
      return type;
    const types = [];
    type._collectAllTypes(types);
    let success = false;
    for (const t of types) {
      if (t.name === 'Object') {
        t.properties = properties;
        success = true;
      }
    }
    if (!success)
      throw new Error('Nested properties given, but there are no objects in type expression: ' + expression);
    return type;
  }

  /**
   * @param {ParsedType} parsedType
   * @return {Documentation.Type}
   */
  static fromParsedType(parsedType, inUnion = false) {
    if (!inUnion && parsedType.union) {
      const type = new Documentation.Type('union');
      type.union = [];
      for (let t = parsedType; t; t = t.union)
        type.union.push(Documentation.Type.fromParsedType(t, true));
      return type;
    }

    if (parsedType.args) {
      const type = new Documentation.Type('function');
      type.args = [];
      for (let t = parsedType.args; t; t = t.next)
        type.args.push(Documentation.Type.fromParsedType(t));
      type.returnType = parsedType.retType ? Documentation.Type.fromParsedType(parsedType.retType) : null;
      return type;
    }

    if (parsedType.template) {
      const type = new Documentation.Type(parsedType.name);
      type.templates = [];
      for (let t = parsedType.template; t; t = t.next)
        type.templates.push(Documentation.Type.fromParsedType(t));
      return type;
    }
    return new Documentation.Type(parsedType.name);
  }

  /**
   * @param {string} name
   * @param {!Array<!Documentation.Member>=} properties
   */
  constructor(name, properties) {
    this.name = name.replace(/^\[/, '').replace(/\]$/, '');
    this.properties = this.name === 'Object' ? properties : undefined;
    /** @type {Documentation.Type[]} | undefined */
    this.union;
    /** @type {Documentation.Type[]} | undefined */
    this.args;
    /** @type {Documentation.Type} | undefined */
    this.returnType;
    /** @type {Documentation.Type[]} | undefined */
    this.templates;
    /** @type {string | undefined } */
    this.expression;
  }

  visit(visitor) {
    const types = [];
    this._collectAllTypes(types);
    for (const type of types) {
      for (const p of type.properties || [])
        p.visit(visitor);
    }
  }

  /**
   * @returns {Documentation.Member[]}
   */
  deepProperties() {
    const types = [];
    this._collectAllTypes(types);
    for (const type of types) {
      if (type.properties && type.properties.length)
        return type.properties;
    }
    return [];
  }

  /**
   * @param {Documentation.Type[]} result
   */
  _collectAllTypes(result) {
    result.push(this);
    for (const t of this.union || [])
      t._collectAllTypes(result);
    for (const t of this.args || [])
      t._collectAllTypes(result);
    for (const t of this.templates || [])
      t._collectAllTypes(result);
    if (this.returnType)
      this.returnType._collectAllTypes(result);
  }
};

/**
 * @param {string} type
 * @returns {ParsedType}
 */
function parseTypeExpression(type) {
  type = type.trim();
  let name = type;
  let next = null;
  let template = null;
  let args = null;
  let retType = null;
  let firstTypeLength = type.length;

  for (let i = 0; i < type.length; i++) {
    if (type[i] === '<') {
      name = type.substring(0, i);
      const matching = matchingBracket(type.substring(i), '<', '>');
      template = parseTypeExpression(type.substring(i + 1, i + matching - 1));
      firstTypeLength = i + matching;
      break;
    }
    if (type[i] === '(') {
      name = type.substring(0, i);
      const matching = matchingBracket(type.substring(i), '(', ')');
      args = parseTypeExpression(type.substring(i + 1, i + matching - 1));
      i = i + matching;
      if (type[i] === ':') {
        retType = parseTypeExpression(type.substring(i + 1));
        next = retType.next;
        retType.next = null;
        break;
      }
    }
    if (type[i] === '|' || type[i] === ',') {
      name = type.substring(0, i);
      firstTypeLength = i;
      break;
    }
  }
  let union = null;
  if (type[firstTypeLength] === '|')
    union = parseTypeExpression(type.substring(firstTypeLength + 1));
  else if (type[firstTypeLength] === ',')
    next = parseTypeExpression(type.substring(firstTypeLength + 1));
  return {
    name,
    args,
    retType,
    template,
    union,
    next
  };
}

/**
 * @param {string} str
 * @param {any} open
 * @param {any} close
 */
function matchingBracket(str, open, close) {
  let count = 1;
  let i = 1;
  for (; i < str.length && count; i++) {
    if (str[i] === open)
      count++;
    else if (str[i] === close)
      count--;
  }
  return i;
}

/**
 * @param {MarkdownNode[]} spec
 * @param {Map<string, Documentation.Class>} classesMap
 * @param {Map<string, Documentation.Member>} membersMap
 * @param {Renderer} linkRenderer
 */
function patchLinks(spec, classesMap, membersMap, linkRenderer) {
  if (!spec)
    return;
  md.visitAll(spec, node => {
    if (!node.text)
      return;
    node.text = node.text.replace(/\[`((?:event|method|property): [^\]]+)`\]/g, (match, p1) => {
      const member = membersMap.get(p1);
      if (!member)
        throw new Error('Undefined member references: ' + match);
      return linkRenderer({ member }) || match;
    });
    node.text = node.text.replace(/\[`(param|option): ([^\]]+)`\]/g, (match, p1, p2) => {
      if (p1 === 'param')
        return linkRenderer({ param: p2 }) || match;
      if (p1 === 'option')
        return linkRenderer({ option: p2 }) || match;
    });
    node.text = node.text.replace(/\[([\w]+)\]/, (match, p1) => {
      const clazz = classesMap.get(p1);
      if (clazz)
        return linkRenderer({ clazz }) || match;
      return match;
    });
  });
}

/**
 * @param {MarkdownNode[]} spec
 */
function generateSourceCodeComment(spec) {
  const comments = (spec || []).filter(n => !n.type.startsWith('h') && (n.type !== 'li' ||  n.liType !== 'default')).map(c => md.clone(c));
  md.visitAll(comments, node => {
    if (node.liType === 'bullet')
      node.liType = 'default';
  });
  return md.render(comments, 120);
}

module.exports = Documentation;
