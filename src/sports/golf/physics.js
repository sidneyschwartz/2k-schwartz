// cannon-es world for golf. Fixed timestep accumulator. Includes simple air drag
// (Cd~0.47) and Magnus side-force from spin so we get a fade/draw on offline strikes.

import * as CANNON from 'cannon-es';

const BALL_RADIUS = 0.0213;     // real golf ball
const BALL_MASS = 0.0459;       // kg
const AIR_DENSITY = 1.225;      // kg/m^3
const Cd = 0.47;                // drag coefficient (smooth sphere ~0.47; real ball is lower with dimples but feels ok)
const FRONTAL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const MAGNUS_K = 0.00012;       // tuned for visible draw/fade without nuking flight

export function createPhysics() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
  world.broadphase = new CANNON.NaiveBroadphase();
  world.allowSleep = true;
  world.defaultContactMaterial.contactEquationStiffness = 1e7;
  world.defaultContactMaterial.contactEquationRelaxation = 4;

  // Materials per surface type
  const fairwayMat = new CANNON.Material('fairway');
  const roughMat = new CANNON.Material('rough');
  const ballMat = new CANNON.Material('ball');

  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, fairwayMat, {
    friction: 0.05, restitution: 0.4,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, roughMat, {
    friction: 0.4, restitution: 0.25,
  }));

  // Ball
  const ballShape = new CANNON.Sphere(BALL_RADIUS);
  const ball = new CANNON.Body({
    mass: BALL_MASS,
    shape: ballShape,
    material: ballMat,
    linearDamping: 0.0,    // handled manually via drag force
    angularDamping: 0.25,
  });
  ball.allowSleep = true;
  ball.sleepSpeedLimit = 0.05;
  ball.sleepTimeLimit = 0.8;
  world.addBody(ball);

  // Default infinite ground plane (rough) at y=0. Per-hole terrain stacks slight Y offsets
  // on top (greens > fairway > rough) so the ball rolls on the correct surface. This plane
  // is also the catch-all for shots that fly off the course.
  const groundBody = new CANNON.Body({ mass: 0, material: roughMat });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const staticBodies = [];

  function addStaticMesh(threeMesh, surfaceType = 'fairway') {
    const geo = threeMesh.geometry;
    if (!geo) return null;
    const posAttr = geo.attributes.position;
    const idxAttr = geo.index;
    const vertices = new Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      vertices[i * 3] = posAttr.getX(i);
      vertices[i * 3 + 1] = posAttr.getY(i);
      vertices[i * 3 + 2] = posAttr.getZ(i);
    }
    let indices;
    if (idxAttr) {
      indices = Array.from(idxAttr.array);
    } else {
      indices = new Array(posAttr.count);
      for (let i = 0; i < posAttr.count; i++) indices[i] = i;
    }
    const shape = new CANNON.Trimesh(vertices, indices);
    const body = new CANNON.Body({
      mass: 0,
      material: surfaceType === 'rough' ? roughMat : fairwayMat,
    });
    body.addShape(shape);
    body.position.set(threeMesh.position.x, threeMesh.position.y, threeMesh.position.z);
    body.quaternion.set(
      threeMesh.quaternion.x,
      threeMesh.quaternion.y,
      threeMesh.quaternion.z,
      threeMesh.quaternion.w,
    );
    world.addBody(body);
    staticBodies.push(body);
    return body;
  }

  // Wind state (set per hole). dir is radians in XZ plane; 0 = +Z (with player toward pin).
  // Drag is computed against (v - wind), which naturally produces head/tail/cross effects.
  const wind = { vec: new CANNON.Vec3(0, 0, 0), speed: 0 };
  function setWind({ speed = 0, dir = 0 } = {}) {
    wind.speed = speed;
    wind.vec.set(Math.sin(dir) * speed, 0, Math.cos(dir) * speed);
  }

  // Per-step aerodynamics on the ball.
  const _drag = new CANNON.Vec3();
  const _vRel = new CANNON.Vec3();
  const _magnus = new CANNON.Vec3();
  function applyAerodynamics() {
    if (ball.sleepState === CANNON.Body.SLEEPING) return;
    const v = ball.velocity;
    // Only apply wind to the ball while it's in flight (above the ground a bit) so
    // a putt isn't pushed sideways by a 6 m/s breeze.
    const inFlight = ball.position.y > BALL_RADIUS * 3 && v.length() > 0.5;
    if (inFlight) {
      _vRel.set(v.x - wind.vec.x, v.y - wind.vec.y, v.z - wind.vec.z);
    } else {
      _vRel.set(v.x, v.y, v.z);
    }
    const relSpeed = _vRel.length();
    if (relSpeed < 0.05) return;
    // Drag: F = -0.5 * rho * Cd * A * |vRel| * vRel
    const k = 0.5 * AIR_DENSITY * Cd * FRONTAL_AREA * relSpeed;
    _drag.set(-_vRel.x * k, -_vRel.y * k, -_vRel.z * k);
    ball.applyForce(_drag, ball.position);
    // Magnus: F = k * (omega x vRel)
    const w = ball.angularVelocity;
    _magnus.set(
      w.y * _vRel.z - w.z * _vRel.y,
      w.z * _vRel.x - w.x * _vRel.z,
      w.x * _vRel.y - w.y * _vRel.x,
    );
    _magnus.scale(MAGNUS_K * relSpeed, _magnus);
    ball.applyForce(_magnus, ball.position);
  }

  const FIXED_DT = 1 / 60;
  const MAX_SUBSTEPS = 6;
  let accumulator = 0;

  function step(dt) {
    accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      applyAerodynamics();
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps += 1;
    }
  }

  function dispose() {
    while (world.bodies.length) world.removeBody(world.bodies[0]);
  }

  function removeStaticBodies() {
    for (const b of staticBodies) world.removeBody(b);
    staticBodies.length = 0;
  }

  return {
    world,
    ball,
    addStaticMesh,
    removeStaticBodies,
    setWind,
    step,
    dispose,
    BALL_RADIUS,
    materials: { fairwayMat, roughMat, ballMat },
  };
}
