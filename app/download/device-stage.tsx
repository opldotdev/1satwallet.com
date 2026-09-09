"use client";

import { Center, PerspectiveCamera } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, SMAA } from "@react-three/postprocessing";
import { Suspense, useEffect, useMemo } from "react";
import { NeutralToneMapping, PlaneGeometry } from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { MacBook } from "./mac-scene";
import { Phone, Studio } from "./phone-scene";

function Tabletop() {
	const floor = useMemo(() => {
		const baseShader = (
			Reflector as typeof Reflector & {
				ReflectorShader: {
					uniforms: Record<string, { value: unknown }>;
					vertexShader: string;
					fragmentShader: string;
				};
			}
		).ReflectorShader;
		const shader = {
			...baseShader,
			vertexShader: baseShader.vertexShader
				.replace("void main()", "varying vec4 floorClip; void main()")
				.replace(
					"#include <logdepthbuf_vertex>",
					"#include <logdepthbuf_vertex>\n floorClip = gl_Position;",
				)
				.replace(
					"varying vec4 vUv;",
					"varying vec4 vUv; varying float floorZ; varying float floorX;",
				)
				.replace(
					"vUv = textureMatrix",
					"floorZ = (modelMatrix * vec4(position, 1.0)).z; floorX = (modelMatrix * vec4(position, 1.0)).x; vUv = textureMatrix",
				),
			fragmentShader: baseShader.fragmentShader
				.replace("void main()", "varying vec4 floorClip; void main()")
				.replace(
					"#include <tonemapping_fragment>",
					"gl_FragColor.rgb *= smoothstep(0.0, 0.16, floorClip.x / floorClip.w * 0.5 + 0.5) * smoothstep(0.0, 0.2, floorClip.y / floorClip.w * 0.5 + 0.5);\n#include <tonemapping_fragment>",
				)
				.replace(
					"varying vec4 vUv;",
					"varying vec4 vUv; varying float floorZ; varying float floorX;",
				)
				.replace(
					"vec4 base = texture2DProj( tDiffuse, vUv );",
					`vec2 uv = vUv.xy / vUv.w;
				vec4 base = vec4(0.0);
				for (int x = -3; x <= 3; x++) {
					for (int y = -3; y <= 3; y++) {
						base += texture2D(tDiffuse, uv + vec2(float(x), float(y)) * 0.0025) / 49.0;
					}
				}`,
				)
				.replace(
					"blendOverlay( base.rgb, color )",
					"blendOverlay( base.rgb, color ) * exp(-1.8 * max(0.0, floorZ - 1.0))",
				),
		};
		const reflector = new Reflector(new PlaneGeometry(30, 30), {
			color: 0x888888,
			textureWidth: 512,
			textureHeight: 512,
			shader,
		});
		reflector.rotation.x = -Math.PI / 2;
		reflector.position.y = -0.01;
		return reflector;
	}, []);
	useEffect(
		() => () => {
			floor.dispose();
			floor.geometry.dispose();
		},
		[floor],
	);
	return <primitive object={floor} />;
}

export default function DeviceStage({ onReady }: { onReady: () => void }) {
	return (
		<Canvas
			dpr={2}
			frameloop="demand"
			gl={{ alpha: true, antialias: true, toneMapping: NeutralToneMapping }}
		>
			<PerspectiveCamera
				makeDefault
				fov={30}
				near={0.5}
				far={40}
				position={[0, 1.45, 7]}
				onUpdate={(camera) => camera.lookAt(0, 1, 0)}
			/>
			<Studio />
			<directionalLight position={[-3, 5, 4]} intensity={0.7} />
			<directionalLight position={[4, 3, -2]} intensity={1.5} />
			<Suspense fallback={null}>
				<Center top scale={1.15} position={[0.7, 0, -0.5]}>
					<MacBook onReady={onReady} />
				</Center>
				<Center top scale={0.9} position={[-1.15, 0, 1.12]}>
					<Phone onReady={onReady} />
				</Center>
				<Tabletop />
			</Suspense>
			<EffectComposer multisampling={4}>
				<SMAA />
			</EffectComposer>
		</Canvas>
	);
}
