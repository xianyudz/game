/* ================================================================
 *  合成大西瓜 · 游戏核心（game-core.js）
 * ----------------------------------------------------------------
 *  这个文件负责"规则"：球怎么掉、怎么撞、怎么合成、怎么算分、什么时候输。
 *  它不知道画面长什么样——画面在 index.html 里。
 *  两者分开是为了让规则可以被单独测试。
 *
 *  ★ 一般来说你不需要改这个文件。要调游戏请改 config.js。
 * ================================================================ */

(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory(require('matter-js'));
  } else {
    root.SuikaCore = factory(root.Matter);
  }
})(typeof self !== 'undefined' ? self : this, function (Matter) {
  'use strict';

  if (!Matter) {
    throw new Error('没有找到 Matter.js。请确认 lib/matter.min.js 已经正确加载。');
  }

  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /** 浅合并（等价于 Object.assign，为兼容老浏览器手写一个） */
  function extend(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** 多边形的有向面积（判断绕向用） */
  function signedArea(verts) {
    var a = 0;
    for (var i = 0; i < verts.length; i++) {
      var p = verts[i], q = verts[(i + 1) % verts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  /** 统一所有多边形的绕向。
   *  画面里是把所有块一次性填色的，绕向不一致的地方会被"挖空"。 */
  function normalizeWinding(sets) {
    if (!sets || sets.length < 2) return sets;
    var want = signedArea(sets[0]) >= 0;
    for (var i = 1; i < sets.length; i++) {
      if ((signedArea(sets[i]) >= 0) !== want) sets[i] = sets[i].slice().reverse();
    }
    return sets;
  }

  /** 把用户配置安全地合并到默认配置上：用户删掉某一节也不会崩。 */
  function deepMerge(base, extra) {
    var out = {};
    var k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    if (!isPlainObject(extra)) return out;
    for (k in extra) {
      if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
      if (extra[k] === undefined) continue;
      if (isPlainObject(out[k]) && isPlainObject(extra[k])) {
        out[k] = deepMerge(out[k], extra[k]);
      } else {
        out[k] = extra[k];
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * 默认配置（config.js 万一被改坏了，就用这里的值兜底）
   * --------------------------------------------------------------- */
  var DEFAULTS = {
    levels: [
      { name: 'L1', image: 'images/1.png', radius: 14, color: '#FF8FA3', emoji: '\uD83C\uDF47' },
      { name: 'L2', image: 'images/2.png', radius: 18, color: '#FFC46B', emoji: '\uD83C\uDF52' },
      { name: 'L3', image: 'images/3.png', radius: 24, color: '#FFE066', emoji: '\uD83C\uDF4A' },
      { name: 'L4', image: 'images/4.png', radius: 31, color: '#B8E986', emoji: '\uD83C\uDF4B' },
      { name: 'L5', image: 'images/5.png', radius: 39, color: '#6FD08C', emoji: '\uD83E\uDD5D' },
      { name: 'L6', image: 'images/6.png', radius: 48, color: '#5FC9C0', emoji: '\uD83C\uDF45' },
      { name: 'L7', image: 'images/7.png', radius: 59, color: '#5BA8F5', emoji: '\uD83C\uDF51' },
      { name: 'L8', image: 'images/8.png', radius: 71, color: '#8F7CF0', emoji: '\uD83C\uDF4D' },
      { name: 'L9', image: 'images/9.png', radius: 84, color: '#C77DFF', emoji: '\uD83E\uDD65' },
      { name: 'L10', image: 'images/10.png', radius: 96, color: '#FF7AB6', emoji: '\uD83C\uDF48' },
      { name: 'L11', image: 'images/11.png', radius: 108, color: '#FF5B5B', emoji: '\uD83C\uDF49' }
    ],
    board: { width: 480, height: 720 },
    physics: {
      gravity: 1.0, restitution: 0.12, friction: 0.45, frictionStatic: 0.6,
      frictionAir: 0.008, density: 0.001, slop: 0.05,
      positionIterations: 10, velocityIterations: 8, maxSides: 64,
      collisionShape: 'silhouette',   // 'silhouette' = 按人物真实轮廓 | 'circle' = 圆形
      maxParts: 24                    // 单个刚体最多保留几块碰撞体
    },
    drop: { pool: [1, 2, 3, 4, 5], weights: [5, 4, 3, 2, 1], spawnY: 60, cooldownMs: 420 },
    score: { merge: [1, 3, 6, 10, 15, 21, 28, 36, 45, 55], maxLevelBonus: 200 },
    dangerLine: { y: 130, holdMs: 1500, ignoreNewMs: 700, color: '#ff5252' },
    appearance: {
      showBubble: false, bubbleAlpha: 0.3, clipImageToCircle: false, imageScale: 1,
      imageOffsetY: 0, rotateWithPhysics: true, rotateAmount: 0.35,
      showRing: false, showDropGuide: true, showHitbox: false, background: 'auto'
    },
    sound: { enabled: true, volume: 0.5, dropPitch: 520, mergeBasePitch: 440 },
    misc: { showNextPreview: true, showLevelGallery: true, maxParticles: 240, recordBest: true }
  };

  var STORAGE_KEY = 'suika-photo-best-score-v1';

  /* ===============================================================
   * 游戏主体
   * =============================================================== */
  function SuikaGame(options) {
    options = options || {};

    this.cfg = deepMerge(DEFAULTS, options.config || {});
    this.hooks = options.hooks || {};
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.storage = options.storage || null;
    this.imageMeta = options.imageMeta || null;   // 每张图"非透明部分"的轮廓数据
    this._Matter = Matter;
    this._shapeCache = {};

    var cfg = this.cfg;

    // 场地尺寸
    this.W = cfg.board.width;
    this.H = cfg.board.height;

    // 等级表整理（保证半径是递增的，否则物体会炸开）
    this.levels = cfg.levels.slice();
    for (var i = 1; i < this.levels.length; i++) {
      if (this.levels[i].radius <= this.levels[i - 1].radius) {
        console.warn('[合成大西瓜] 第 ' + (i + 1) + ' 级的 radius 没有比上一级大，已自动修正。请检查 config.js');
        this.levels[i].radius = this.levels[i - 1].radius + 6;
      }
    }

    // 物理引擎
    this.engine = Matter.Engine.create({ gravity: { x: 0, y: cfg.physics.gravity } });
    this.engine.positionIterations = Math.max(2, cfg.physics.positionIterations | 0);
    this.engine.velocityIterations = Math.max(2, cfg.physics.velocityIterations | 0);
    this.world = this.engine.world;

    // 状态
    this.balls = [];
    this.byId = new Map();
    this.effects = [];
    this.pendingMerges = [];
    this.score = 0;
    this.best = 0;
    this.status = 'ready';       // ready | playing | over
    this.heldLevel = 0;
    this.nextLevel = 0;
    this.aimX = this.W / 2;
    this.cooldown = 0;
    this.dangerTimer = 0;
    this.time = 0;
    this.acc = 0;
    this.dropCount = 0;
    this.mergeCount = 0;
    this.maxLevelReached = 1;
    this.unlocked = {};
    this.overAt = 0;
    this.overReason = '';
    this._lastStep = 1000 / 60;

    this._buildWalls();
    this._bindCollisions();

    this.best = this._loadBest();
  }

  SuikaGame.prototype = {

    constructor: SuikaGame,

    /* ---------------- 场地边界 ---------------- */
    _buildWalls: function () {
      var t = 240;                       // 墙的厚度（够厚就不会被顶穿）
      var W = this.W, H = this.H;
      var opt = {
        isStatic: true,
        label: 'wall',
        friction: this.cfg.physics.friction,
        frictionStatic: this.cfg.physics.frictionStatic,
        restitution: 0
      };
      this.walls = [
        Matter.Bodies.rectangle(-t / 2, H / 2, t, H + 800, opt),        // 左墙
        Matter.Bodies.rectangle(W + t / 2, H / 2, t, H + 800, opt),     // 右墙
        Matter.Bodies.rectangle(W / 2, H + t / 2, W + t * 2, t, opt)    // 地板
      ];
      Matter.Composite.add(this.world, this.walls);
    },

    /* ---------------- 碰撞 → 排队等待合成 ---------------- */
    _bindCollisions: function () {
      var self = this;
      Matter.Events.on(this.engine, 'collisionStart', function (ev) {
        var pairs = ev.pairs;
        for (var i = 0; i < pairs.length; i++) {
          // ★ 重要：轮廓碰撞是"复合刚体"，Matter 在事件里给的是撞到的
          //   那一小块（part），必须顺着 .parent 找回真正的球。
          var ba = pairs[i].bodyA, bb = pairs[i].bodyB;
          var pa = ba && (ba.parent || ba);
          var pb = bb && (bb.parent || bb);
          if (!pa || !pb) continue;
          var a = self.byId.get(pa.id);
          var b = self.byId.get(pb.id);
          if (!a || !b) continue;
          if (a.level !== b.level) continue;
          if (a.claimed || b.claimed || a.removed || b.removed) continue;
          a.claimed = true;
          b.claimed = true;
          self.pendingMerges.push([a, b]);
        }
      });
    },

    /* ============================================================
     *  碰撞形状
     * ------------------------------------------------------------
     *  'silhouette'：拿图片里"非透明部分"的真实轮廓当碰撞体。
     *                轮廓的每一块都是凸四边形（提前在 Node 里算好，
     *                存在 images-meta.js 里），这里负责缩放和拼装。
     *  'circle'    ：传统的圆形球。
     * ============================================================ */

    /** 取某个等级的碰撞形状（算一次就缓存起来） */
    shapeOf: function (level) {
      if (this._shapeCache[level]) return this._shapeCache[level];
      var s = this._buildShape(level);
      this._shapeCache[level] = s;
      return s;
    },

    _imageScaleOf: function (info) {
      if (info && info.imageScale != null) return info.imageScale;
      var v = this.cfg.appearance.imageScale;
      return v == null ? 1 : v;
    },

    _offsetYOf: function (info) {
      if (info && info.imageOffsetY != null) return info.imageOffsetY;
      return this.cfg.appearance.imageOffsetY || 0;
    },

    _buildShape: function (level) {
      var cfg = this.cfg;
      var info = this.levels[level - 1];
      var r = info.radius;
      var circle = { kind: 'circle', radius: r, halfW: r, halfH: r, level: level };

      if (cfg.physics.collisionShape === 'circle') return circle;

      var meta = this.imageMeta && this.imageMeta[String(level)];
      if (!meta || !meta.parts || !meta.parts.length) return circle;

      // 把"图片"当成一个宽 AR、高 1 的矩形，等比缩放到 2r
      var AR = meta.w / meta.h;
      var boxW = meta.bw * AR;
      var boxH = meta.bh * 1;
      var maxSide = Math.max(boxW, boxH);
      if (!(maxSide > 0) || !isFinite(AR)) return circle;

      var k = (2 * r * this._imageScaleOf(info)) / maxSide;
      var offY = this._offsetYOf(info);

      var sets = meta.parts.map(function (poly) {
        return poly.map(function (p) {
          return { x: (p[0] - 0.5) * AR * k, y: (p[1] - 0.5) * k + offY };
        });
      })
        // 保险：取凸包。凹多边形会让物理引擎报错并产生 NaN。
        .map(function (v) { return Matter.Vertices.hull(v); })
        .filter(function (v) {
          return v.length >= 3 && Math.abs(Matter.Vertices.area(v, true)) > 0.5;
        });

      if (!sets.length) return circle;
      normalizeWinding(sets);

      var maxParts = Math.max(1, cfg.physics.maxParts | 0);
      if (sets.length > maxParts) {
        // 块太多就按面积保留最大的几块，防止物理变慢
        sets.sort(function (a, b) {
          return Math.abs(Matter.Vertices.area(b, true)) - Math.abs(Matter.Vertices.area(a, true));
        });
        sets = sets.slice(0, maxParts);
      }

      // 算出"图片中心"相对刚体质心偏了多少 —— 画图时要按这个偏移画，否则图会飘
      var probe = this._assemble(sets, {});
      var c1x = (probe.bounds.min.x + probe.bounds.max.x) / 2;
      var c1y = (probe.bounds.min.y + probe.bounds.max.y) / 2;
      var c0x = AR * (meta.x + meta.bw / 2 - 0.5) * k;
      var c0y = k * (meta.y + meta.bh / 2 - 0.5) + offY;

      return {
        kind: 'silhouette',
        level: level,
        radius: r,
        halfW: (boxW * k) / 2,
        halfH: (boxH * k) / 2,
        AR: AR,
        k: k,
        offsetY: offY,
        parts: sets,
        drawW: AR * k,     // 整张图片缩放后有多宽
        drawH: k,          // 整张图片缩放后有多高
        imgLocal: { x: (c1x - c0x) - probe.position.x, y: (c1y - c0y) - probe.position.y }
      };
    },

    /** 把多块凸多边形拼成一个复合刚体。
     *  注意：不能用 Matter 的 Bodies.fromVertices ——
     *  它在多块凸多边形时会把每一块都拉到原点叠在一起（Matter 的坑）。
     *  必须每块放到自己的重心上，再用 Body.setParts 拼。 */
    _assemble: function (sets, options) {
      var parts = sets.map(function (verts) {
        var c = Matter.Vertices.centre(verts);
        return Matter.Body.create(extend({}, options, {
          position: { x: c.x, y: c.y },
          vertices: verts
        }));
      });
      var parent = Matter.Body.create(extend({}, options));
      Matter.Body.setParts(parent, parts);
      return parent;
    },

    /** 把整块刚体推回场地内（避免刚生成就卡在墙里被弹飞） */
    _clampBodyToBoard: function (body) {
      var b = body.bounds;
      var dx = 0, dy = 0;
      if (b.min.x < 0.5) dx = 0.5 - b.min.x;
      else if (b.max.x > this.W - 0.5) dx = (this.W - 0.5) - b.max.x;
      if (b.max.y > this.H - 0.5) dy = (this.H - 0.5) - b.max.y;
      else if (b.min.y < -300) dy = -300 - b.min.y;
      if (dx || dy) {
        Matter.Body.setPosition(body, { x: body.position.x + dx, y: body.position.y + dy });
      }
      return body;
    },

    _bodyOptions: function () {
      var p = this.cfg.physics;
      return {
        label: 'suika-ball',
        restitution: p.restitution,
        friction: p.friction,
        frictionStatic: p.frictionStatic,
        frictionAir: p.frictionAir,
        density: p.density,
        slop: p.slop
      };
    },

    /* ---------------- 造球 ---------------- */
    _createBall: function (level, x, y, opts) {
      opts = opts || {};
      var cfg = this.cfg;
      var shape = this.shapeOf(level);
      var body;

      if (shape.kind === 'silhouette') {
        body = this._assemble(shape.parts, this._bodyOptions());
        // (x, y) 是"图片中心"，刚体质心要按偏移量摆
        Matter.Body.setPosition(body, {
          x: x - shape.imgLocal.x,
          y: y - shape.imgLocal.y
        });
        // rotateWithPhysics = false → 照片永远正着，不会翻滚（堆起来更整齐）
        if (this.cfg.appearance.rotateWithPhysics === false) {
          Matter.Body.setInertia(body, Infinity);
        }
        this._clampBodyToBoard(body);
      } else {
        var r = shape.radius;
        var px = clamp(x, r + 0.5, this.W - r - 0.5);
        var py = clamp(y, r + 0.5, this.H - r - 0.5);
        body = Matter.Bodies.circle(px, py, r, this._bodyOptions(), cfg.physics.maxSides);
      }

      var vx = opts.vx || 0, vy = opts.vy || 0;
      var speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > 8) { vx = vx / speed * 8; vy = vy / speed * 8; }
      Matter.Body.setVelocity(body, { x: vx, y: vy });

      var rec = {
        level: level,
        radius: shape.radius,
        kind: shape.kind,
        shape: shape,
        halfW: shape.halfW,
        halfH: shape.halfH,
        body: body,
        born: this.time,
        everBelow: false,
        claimed: false,
        removed: false,
        popIn: !!opts.popIn,
        popT: opts.popIn ? 0 : 1,
        spawnFlash: opts.popIn ? 1 : 0,
        fromDrop: !!opts.fromDrop
      };

      this.byId.set(body.id, rec);
      this.balls.push(rec);
      Matter.Composite.add(this.world, body);

      if (level > this.maxLevelReached) this.maxLevelReached = level;
      this.unlocked[level] = true;

      this._emit('spawn', rec);
      return rec;
    },

    _removeBall: function (rec) {
      if (!rec || rec.removed) return;
      rec.removed = true;
      Matter.Composite.remove(this.world, rec.body);
      this.byId.delete(rec.body.id);
      var i = this.balls.indexOf(rec);
      if (i >= 0) this.balls.splice(i, 1);
    },

    /** 这个球的"图片中心"在世界坐标的哪里（合成时按这个位置落点） */
    centerOf: function (rec) {
      var p = rec.body.position;
      if (rec.kind !== 'silhouette' || !rec.shape) return { x: p.x, y: p.y };
      var il = rec.shape.imgLocal;
      var a = rec.body.angle;
      var ca = Math.cos(a), sa = Math.sin(a);
      return { x: p.x + il.x * ca - il.y * sa, y: p.y + il.x * sa + il.y * ca };
    },

    /* ---------------- 随机抽取下一个等级 ---------------- */
    _pickLevel: function () {
      var pool = this.cfg.drop.pool;
      if (!pool || !pool.length) return 1;
      var weights = this.cfg.drop.weights;
      var total = 0, i;
      var useWeights = weights && weights.length === pool.length;
      if (useWeights) {
        for (i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
      }
      var maxLevel = this.levels.length;
      if (!useWeights || total <= 0) {
        return clamp(pool[(this.random() * pool.length) | 0], 1, maxLevel);
      }
      var roll = this.random() * total;
      for (i = 0; i < pool.length; i++) {
        roll -= Math.max(0, weights[i]);
        if (roll <= 0) return clamp(pool[i], 1, maxLevel);
      }
      return clamp(pool[pool.length - 1], 1, maxLevel);
    },

    /* ---------------- 开局 / 重开 ---------------- */
    reset: function () {
      var i;
      for (i = this.balls.length - 1; i >= 0; i--) {
        Matter.Composite.remove(this.world, this.balls[i].body);
      }
      this.balls = [];
      this.byId.clear();
      this.effects = [];
      this.pendingMerges = [];
      this.score = 0;
      this.status = 'ready';
      this.heldLevel = 0;
      this.nextLevel = 0;
      this.aimX = this.W / 2;
      this.cooldown = 0;
      this.dangerTimer = 0;
      this.time = 0;
      this.acc = 0;
      this.dropCount = 0;
      this.mergeCount = 0;
      this.maxLevelReached = 1;
      this.unlocked = {};
      this.overReason = '';
      this._emit('reset', null);
    },

    start: function () {
      this.reset();
      this.status = 'playing';
      this.heldLevel = this._pickLevel();
      this.nextLevel = this._pickLevel();
      this._emit('start', null);
      return this;
    },

    restart: function () {
      this.start();
      this._emit('score', this.score);
      return this;
    },

    /* ---------------- 瞄准 ---------------- */
    setAim: function (x) {
      this.aimX = clamp(x, 0, this.W);
      return this.aimX;
    },

    moveAim: function (dx) {
      this.aimX = clamp(this.aimX + dx, 0, this.W);
      return this.aimX;
    },

    /** 当前待放球的合法横坐标范围 */
    aimRange: function () {
      if (!this.heldLevel) return { min: 0, max: this.W };
      var hw = this.shapeOf(this.heldLevel).halfW;
      return { min: hw + 2, max: this.W - hw - 2 };
    },

    /* ---------------- 放球 ---------------- */
    drop: function (x) {
      if (this.status !== 'playing') return false;
      if (this.heldLevel === 0) return false;
      if (this.cooldown > 0) return false;

      if (typeof x === 'number') this.setAim(x);

      var level = this.heldLevel;
      var shape = this.shapeOf(level);
      var range = this.aimRange();
      var px = clamp(this.aimX, range.min, range.max);
      var py = Math.max(shape.halfH + 2, this.cfg.drop.spawnY);

      var rec = this._createBall(level, px, py, { fromDrop: true });

      this.heldLevel = 0;
      this.cooldown = Math.max(0, this.cfg.drop.cooldownMs);
      this.dropCount++;
      this._emit('drop', rec);
      this._emit('sfx', { type: 'drop', level: level });
      return true;
    },

    /* ---------------- 主循环（dt 单位：毫秒） ---------------- */
    update: function (dtMs) {
      if (!isFinite(dtMs) || dtMs < 0) dtMs = 0;
      dtMs = Math.min(dtMs, 100);            // 切后台回来时不要瞬间爆炸
      this.acc += dtMs;
      this._lastStep = 1000 / 60;

      var steps = 0;
      while (this.acc >= this._lastStep && steps < 5) {
        this._fixedStep(this._lastStep);
        this.acc -= this._lastStep;
        steps++;
      }
      if (steps === 5) this.acc = 0;

      this._updateEffects(dtMs);
      return this;
    },

    _fixedStep: function (step) {
      this.time += step;

      Matter.Engine.update(this.engine, step);

      this._processMerges();
      this._updateBallAnim(step);
      this._checkGameOver(step);

      if (this.status === 'playing' && this.cooldown > 0) {
        this.cooldown -= step;
        if (this.cooldown <= 0) {
          this.cooldown = 0;
          if (this.heldLevel === 0) {
            this.heldLevel = this.nextLevel || this._pickLevel();
            this.nextLevel = this._pickLevel();
            this._emit('next', { heldLevel: this.heldLevel, nextLevel: this.nextLevel });
          }
        }
      }
    },

    _updateBallAnim: function (step) {
      for (var i = 0; i < this.balls.length; i++) {
        var rec = this.balls[i];
        if (rec.popIn && rec.popT < 1) {
          rec.popT = Math.min(1, rec.popT + step / 200);
        }
        if (rec.spawnFlash > 0) rec.spawnFlash = Math.max(0, rec.spawnFlash - step / 260);
      }
    },

    /* ---------------- 合成 ---------------- */
    _processMerges: function () {
      if (!this.pendingMerges.length) return;
      var queue = this.pendingMerges;
      this.pendingMerges = [];

      for (var i = 0; i < queue.length; i++) {
        var a = queue[i][0], b = queue[i][1];
        if (a.removed || b.removed) continue;

        var level = a.level;
        var info = this.levels[level - 1];
        var ca = this.centerOf(a), cb = this.centerOf(b);
        var mx = (ca.x + cb.x) / 2;
        var my = (ca.y + cb.y) / 2;
        var vx = (a.body.velocity.x + b.body.velocity.x) / 2;
        var vy = (a.body.velocity.y + b.body.velocity.y) / 2;
        var color = info.color || '#ffffff';

        this._removeBall(a);
        this._removeBall(b);
        this.mergeCount++;

        var isMax = level >= this.levels.length;

        if (isMax) {
          // 两个最大的球相遇 → 双双消失，给大分
          var bonus = this.cfg.score.maxLevelBonus || 0;
          var maxShape = this.shapeOf(level);
          this.score += bonus;
          this._pop(mx, my, (maxShape.halfW + maxShape.halfH) * 0.9, color, 520);
          this._spawnParticles(mx, my, 34, color, 1.9);
          this._floatText(mx, my, '+' + bonus, color);
          this._emit('sfx', { type: 'boom', level: level });
          this._emit('merge', { level: level, x: mx, y: my, vanished: true });
        } else {
          var newRec = this._createBall(level + 1, mx, my, { vx: vx, vy: vy, popIn: true });
          var gain = (this.cfg.score.merge && this.cfg.score.merge[level - 1]) || 0;
          this.score += gain;
          this._pop(mx, my, newRec.halfW + newRec.halfH, color, 420);
          this._spawnParticles(mx, my, 14 + level * 2, color, 1 + level * 0.08);
          this._floatText(mx, my, '+' + gain, color);
          this._emit('sfx', { type: 'merge', level: level + 1 });
          this._emit('merge', { level: level + 1, x: mx, y: my, rec: newRec, vanished: false });
        }

        this._emit('score', this.score);
        this._saveBest();
      }
    },

    /* ---------------- 输赢 ---------------- */
    _checkGameOver: function (step) {
      if (this.status !== 'playing') return;

      var dangerY = this.cfg.dangerLine.y;
      var ignoreNew = this.cfg.dangerLine.ignoreNewMs || 0;
      var over = false;

      for (var i = 0; i < this.balls.length; i++) {
        var rec = this.balls[i];
        // 用刚体真实的最高点（圆形和轮廓碰撞体都适用）
        var top = rec.body.bounds.min.y;
        if (top > dangerY) {
          rec.everBelow = true;
        } else if (rec.everBelow && (this.time - rec.born) > ignoreNew) {
          over = true;
          break;
        }
      }

      if (over) {
        this.dangerTimer += step;
      } else {
        this.dangerTimer = Math.max(0, this.dangerTimer - step * 2.5);
      }

      if (this.dangerTimer >= (this.cfg.dangerLine.holdMs || 1500)) {
        this._gameOver('球堆超过了警戒线');
      }
    },

    _gameOver: function (reason) {
      if (this.status === 'over') return;
      this.status = 'over';
      this.overAt = this.time;
      this.overReason = reason || '';
      this._saveBest(true);
      this._emit('gameover', { score: this.score, best: this.best, reason: this.overReason });
    },

    /** 外部（比如"我认输"按钮）主动结束 */
    forceGameOver: function (reason) { this._gameOver(reason || '手动结束'); },

    /* ---------------- 特效 ---------------- */
    _pop: function (x, y, radius, color, life) {
      this.effects.push({ kind: 'pop', x: x, y: y, radius: radius, color: color, t: 0, life: life || 420 });
    },

    _floatText: function (x, y, text, color) {
      this.effects.push({ kind: 'text', x: x, y: y, text: text, color: color, t: 0, life: 780 });
    },

    _spawnParticles: function (x, y, count, color, power) {
      var max = this.cfg.misc.maxParticles || 240;
      power = power || 1;
      for (var i = 0; i < count; i++) {
        if (this.effects.length > max + 40) break;
        var ang = this.random() * TAU;
        var spd = (0.6 + this.random() * 2.6) * power;
        this.effects.push({
          kind: 'particle',
          x: x, y: y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 0.6 * power,
          size: 2 + this.random() * 3.4,
          color: color,
          t: 0,
          life: 420 + this.random() * 520
        });
      }
    },

    _updateEffects: function (dtMs) {
      var out = this.effects;
      var kept = [];
      for (var i = 0; i < out.length; i++) {
        var e = out[i];
        e.t += dtMs;
        if (e.t >= e.life) continue;
        if (e.kind === 'particle') {
          e.x += e.vx * dtMs * 0.06;
          e.y += e.vy * dtMs * 0.06;
          e.vy += 0.006 * dtMs;
          e.vx *= 0.995;
        }
        kept.push(e);
      }
      this.effects = kept;
    },

    /* ---------------- 存档 ---------------- */
    _loadBest: function () {
      if (!this.cfg.misc.recordBest) return 0;
      try {
        if (this.storage && typeof this.storage.get === 'function') {
          var v = parseInt(this.storage.get(STORAGE_KEY), 10);
          return isFinite(v) && v > 0 ? v : 0;
        }
      } catch (e) { /* 忽略：无痕模式等 */ }
      return 0;
    },

    _saveBest: function (force) {
      if (!this.cfg.misc.recordBest) return;
      if (this.score <= this.best && !force) return;
      this.best = Math.max(this.best, this.score);
      try {
        if (this.storage && typeof this.storage.set === 'function') {
          this.storage.set(STORAGE_KEY, String(this.best));
        }
      } catch (e) { /* 忽略 */ }
    },

    /* ---------------- 给画面用的一份快照 ---------------- */
    getState: function () {
      return {
        status: this.status,
        score: this.score,
        best: this.best,
        heldLevel: this.heldLevel,
        nextLevel: this.nextLevel,
        aimX: this.aimX,
        cooldown: this.cooldown,
        cooldownTotal: this.cfg.drop.cooldownMs,
        dangerTimer: this.dangerTimer,
        dangerHold: this.cfg.dangerLine.holdMs,
        balls: this.balls,
        effects: this.effects,
        maxLevelReached: this.maxLevelReached,
        unlocked: this.unlocked,
        dropCount: this.dropCount,
        mergeCount: this.mergeCount,
        overReason: this.overReason,
        W: this.W,
        H: this.H,
        levels: this.levels
      };
    },

    _emit: function (name, payload) {
      var cap = name.charAt(0).toUpperCase() + name.slice(1);
      var fn = this.hooks['on' + cap];
      if (typeof fn !== 'function') {
        // 兼容 onGameOver / onGameover 这类大小写写法
        var want = ('on' + name).toLowerCase();
        for (var k in this.hooks) {
          if (Object.prototype.hasOwnProperty.call(this.hooks, k) && k.toLowerCase() === want) {
            fn = this.hooks[k];
            break;
          }
        }
      }
      if (typeof fn === 'function') {
        try { fn(payload, this); } catch (e) { console.error('[合成大西瓜] 回调出错:', e); }
      }
    }
  };

  return {
    SuikaGame: SuikaGame,
    DEFAULTS: DEFAULTS,
    deepMerge: deepMerge,
    STORAGE_KEY: STORAGE_KEY
  };
});
