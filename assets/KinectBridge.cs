// KinectBridge: streams Kinect 360 hand position to the game over WebSocket (ws://localhost:8181)
// Requires: Windows, Kinect for Windows SDK v1.8, .NET Framework 4.x console project,
//           NuGet package "Fleck", reference to Microsoft.Kinect.dll (from the SDK).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Fleck;
using Microsoft.Kinect;

class Program
{
    static readonly List<IWebSocketConnection> clients = new List<IWebSocketConnection>();

    // "Reach box" around the shoulder, in metres. Smaller = less arm movement needed.
    const double BoxHalfWidth = 0.45;   // left/right of shoulder centre
    const double BoxTop = 0.30;         // above shoulder centre
    const double BoxHeight = 0.80;      // total height of the box

    static double Clamp01(double v) { return Math.Max(0, Math.Min(1, v)); }
    static string F(double v) { return v.ToString("0.000", CultureInfo.InvariantCulture); }

    static void Main()
    {
        var sensor = KinectSensor.KinectSensors.FirstOrDefault(s => s.Status == KinectStatus.Connected);
        if (sensor == null) { Console.WriteLine("No Kinect found. Plug in the sensor + its power adapter."); Console.ReadKey(); return; }

        var server = new WebSocketServer("ws://0.0.0.0:8181");
        server.Start(s =>
        {
            s.OnOpen = () => { lock (clients) clients.Add(s); Console.WriteLine("Game connected"); };
            s.OnClose = () => { lock (clients) clients.Remove(s); };
        });

        sensor.SkeletonStream.Enable(new TransformSmoothParameters
        { Smoothing = 0.5f, Correction = 0.3f, Prediction = 0.4f, JitterRadius = 0.05f, MaxDeviationRadius = 0.04f });

        sensor.SkeletonFrameReady += (o, e) =>
        {
            using (var frame = e.OpenSkeletonFrame())
            {
                if (frame == null) return;
                var skeletons = new Skeleton[frame.SkeletonArrayLength];
                frame.CopySkeletonDataTo(skeletons);

                // Closest tracked player
                var p = skeletons.Where(s => s.TrackingState == SkeletonTrackingState.Tracked)
                                 .OrderBy(s => s.Position.Z).FirstOrDefault();
                string json;
                if (p == null) json = "{\"tracked\":false}";
                else
                {
                    var shoulder = p.Joints[JointType.ShoulderCenter].Position;
                    var head = p.Joints[JointType.Head].Position;
                    var right = p.Joints[JointType.HandRight].Position;
                    var left = p.Joints[JointType.HandLeft].Position;

                    // Use whichever hand is raised higher
                    var hand = right.Y >= left.Y ? right : left;

                    // Kinect X grows toward the sensor's right (= player's left), so flip it for a mirror feel
                    double x = Clamp01((shoulder.X - hand.X + BoxHalfWidth) / (2 * BoxHalfWidth));
                    double y = Clamp01((shoulder.Y + BoxTop - hand.Y) / BoxHeight);
                    bool pause = right.Y > head.Y + 0.1 && left.Y > head.Y + 0.1;

                    json = "{\"tracked\":true,\"x\":" + F(x) + ",\"y\":" + F(y) + ",\"pause\":" + (pause ? "true" : "false") + "}";
                }

                lock (clients) foreach (var c in clients.ToList()) c.Send(json);
            }
        };

        sensor.Start();
        Console.WriteLine("Kinect bridge running on ws://localhost:8181 — press Enter to quit.");
        Console.ReadLine();
        sensor.Stop();
        server.Dispose();
    }
}
